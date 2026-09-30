import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  type AuthenticationResultType,
  type CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  UnauthorizedException,
  UnsupportedTokenTypeException,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";

export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

/** Thrown when Cognito rejects a magic link or a refresh token. Mapped to HTTP 401. */
export class AuthenticationError extends Error {
  constructor(message = "Invalid or expired magic link") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class CognitoService {
  constructor(
    private readonly client: CognitoIdentityProviderClient,
    private readonly userPoolId: string,
    private readonly clientId: string,
  ) {}

  /**
   * Makes sure a Cognito user exists for this email (implicit sign-up). It
   * runs on every sign-in, so it looks the user up first: a returning user
   * costs one AdminGetUser, and AdminCreateUser (the lowest Cognito admin
   * quota) is only called for new users. Two first sign-ins racing are safe:
   * the loser gets UsernameExistsException and re-reads the status.
   * MessageAction=SUPPRESS stops Cognito from sending its own invitation
   * email — our magic link is the only email the user gets.
   *
   * AdminCreateUser leaves the user in FORCE_CHANGE_PASSWORD, and Cognito does
   * not let such users sign in until they set a password. Setting a random
   * permanent one moves the user to CONFIRMED. Nobody ever knows it, and the
   * app client only allows CUSTOM_AUTH, so it can never be used to sign in.
   *
   * If a previous request created the user but failed before confirming it,
   * the next request finds it still in FORCE_CHANGE_PASSWORD and repairs it.
   *
   * The email is created as verified: tokens are only ever issued to someone
   * who clicked a link sent to it, and users cannot change it (the app client
   * has no write access to `email`), so every token proves ownership.
   */
  async ensureUser(email: string): Promise<void> {
    let status = await this.userStatus(email);
    if (status === undefined && !(await this.createUser(email))) status = await this.userStatus(email);
    if (status !== undefined && status !== "FORCE_CHANGE_PASSWORD") return;

    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        Password: unusablePassword(),
        Permanent: true,
      }),
    );
  }

  /** @returns false when the user already existed. */
  private async createUser(email: string): Promise<boolean> {
    try {
      await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof UsernameExistsException) return false;
      throw error;
    }
  }

  /** @returns undefined when there is no such user. */
  private async userStatus(email: string): Promise<string | undefined> {
    try {
      const user = await this.client.send(new AdminGetUserCommand({ UserPoolId: this.userPoolId, Username: email }));
      return user.UserStatus;
    } catch (error) {
      if (error instanceof UserNotFoundException) return undefined;
      throw error;
    }
  }

  /**
   * Revokes a refresh token, and with it the access tokens issued from it.
   * Idempotent: a token Cognito does not recognise is already unusable, so
   * signing out with it succeeds too.
   *
   * ID tokens are verified by API Gateway without asking Cognito, so they stay
   * valid until they expire (15 minutes by default, see token_validity_minutes).
   *
   * @returns false when Cognito did not recognise the token.
   */
  async revokeRefreshToken(refreshToken: string): Promise<boolean> {
    try {
      await this.client.send(new RevokeTokenCommand({ ClientId: this.clientId, Token: refreshToken }));
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException || error instanceof UnsupportedTokenTypeException) return false;
      throw error;
    }
  }

  /**
   * Runs the full CUSTOM_AUTH flow in one call:
   *
   *   InitiateAuth            -> DefineAuthChallenge -> CreateAuthChallenge
   *   RespondToAuthChallenge  -> VerifyAuthChallengeResponse -> DefineAuthChallenge
   *
   * Because the Cognito session is created *here*, at the moment the user
   * clicks the link, there is no need to keep a Cognito `Session` alive for
   * the lifetime of the link (the main pain point in the original article).
   */
  async signInWithMagicLink(email: string, token: string): Promise<AuthTokens> {
    try {
      const challenge = await this.client.send(
        new InitiateAuthCommand({
          AuthFlow: "CUSTOM_AUTH",
          ClientId: this.clientId,
          AuthParameters: { USERNAME: email },
        }),
      );

      if (challenge.ChallengeName !== "CUSTOM_CHALLENGE" || !challenge.Session) {
        throw new AuthenticationError("Unexpected authentication challenge");
      }

      const response = await this.client.send(
        new RespondToAuthChallengeCommand({
          ClientId: this.clientId,
          ChallengeName: "CUSTOM_CHALLENGE",
          Session: challenge.Session,
          ChallengeResponses: {
            // With email as a username attribute, Cognito's internal username
            // is the user's `sub`; it is returned in the challenge parameters.
            USERNAME: challenge.ChallengeParameters?.USERNAME ?? email,
            ANSWER: token,
          },
        }),
      );

      // Cognito answers a wrong response with a new challenge, not an error.
      return toAuthTokens(response.AuthenticationResult, new AuthenticationError());
    } catch (error) {
      if (error instanceof NotAuthorizedException || error instanceof UserNotFoundException) {
        throw new AuthenticationError();
      }
      throw error;
    }
  }

  /**
   * Exchanges a refresh token for new ID and access tokens. Cognito rejects
   * revoked, expired and unknown refresh tokens with NotAuthorizedException.
   * No new refresh token is issued: the client keeps the one it has.
   */
  async refreshSession(refreshToken: string): Promise<AuthTokens> {
    const expired = new AuthenticationError("Session expired or revoked");
    try {
      const response = await this.client.send(
        new InitiateAuthCommand({
          AuthFlow: "REFRESH_TOKEN_AUTH",
          ClientId: this.clientId,
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
      return toAuthTokens(response.AuthenticationResult, expired);
    } catch (error) {
      if (error instanceof NotAuthorizedException) throw expired;
      throw error;
    }
  }
}

function toAuthTokens(result: AuthenticationResultType | undefined, missing: AuthenticationError): AuthTokens {
  if (!result?.IdToken || !result.AccessToken) throw missing;
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn ?? 3600,
    tokenType: result.TokenType ?? "Bearer",
  };
}

/** 32 random bytes plus one character of each class, to satisfy any password policy. */
function unusablePassword(): string {
  return `${randomBytes(32).toString("base64url")}Aa1!`;
}
