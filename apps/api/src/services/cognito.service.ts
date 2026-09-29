import { randomBytes } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  type CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
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

/** Thrown when Cognito rejects the magic link. Mapped to HTTP 401. */
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
   * Makes sure a Cognito user exists for this email (implicit sign-up).
   * Uses create-and-catch instead of get-then-create to avoid a race and an
   * extra round trip. MessageAction=SUPPRESS stops Cognito from sending its
   * own invitation email — our magic link is the only email the user gets.
   *
   * AdminCreateUser leaves the user in FORCE_CHANGE_PASSWORD, and Cognito does
   * not let such users sign in until they set a password. Setting a random
   * permanent one moves the user to CONFIRMED. Nobody ever knows it, and the
   * app client only allows CUSTOM_AUTH, so it can never be used to sign in.
   */
  async ensureUser(email: string): Promise<void> {
    try {
      await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [{ Name: "email", Value: email }],
        }),
      );
    } catch (error) {
      if (error instanceof UsernameExistsException) return;
      throw error;
    }

    await this.client.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: this.userPoolId,
        Username: email,
        Password: unusablePassword(),
        Permanent: true,
      }),
    );
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

      const result = response.AuthenticationResult;
      if (!result?.IdToken || !result.AccessToken) {
        // Cognito answers a wrong response with a new challenge, not an error.
        throw new AuthenticationError();
      }

      return {
        idToken: result.IdToken,
        accessToken: result.AccessToken,
        refreshToken: result.RefreshToken,
        expiresIn: result.ExpiresIn ?? 3600,
        tokenType: result.TokenType ?? "Bearer",
      };
    } catch (error) {
      if (error instanceof NotAuthorizedException || error instanceof UserNotFoundException) {
        throw new AuthenticationError();
      }
      throw error;
    }
  }
}

/** 32 random bytes plus one character of each class, to satisfy any password policy. */
function unusablePassword(): string {
  return `${randomBytes(32).toString("base64url")}Aa1!`;
}
