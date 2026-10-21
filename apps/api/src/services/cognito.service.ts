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

/** Cognito rejected a magic link or a refresh token (HTTP 401). */
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
   * Creates the Cognito user on first sign-in, CONFIRMED with an unusable
   * random password (the client only allows CUSTOM_AUTH). Returning users cost
   * one AdminGetUser; a user left in FORCE_CHANGE_PASSWORD is repaired.
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

  /** @returns false when the user already exists. */
  private async createUser(email: string): Promise<boolean> {
    try {
      await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          MessageAction: "SUPPRESS", // the magic link is the only email
          UserAttributes: [
            { Name: "email", Value: email },
            // Tokens are only issued to whoever clicked a link sent to this address.
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

  /** @returns undefined when the user does not exist. */
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
   * Revokes a refresh token and the access tokens issued from it. ID tokens
   * stay valid until they expire.
   * @returns false when Cognito does not recognise the token.
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
   * Runs CUSTOM_AUTH in one call (InitiateAuth + RespondToAuthChallenge) when
   * the link is used, so no Cognito session has to outlive the email.
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
            // Cognito's internal username (the sub), not the email.
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

  /** New ID and access tokens; the refresh token is not rotated. */
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

/** Random, plus one character of each class to satisfy any password policy. */
function unusablePassword(): string {
  return `${randomBytes(32).toString("base64url")}Aa1!`;
}
