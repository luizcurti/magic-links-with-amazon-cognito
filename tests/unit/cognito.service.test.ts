import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
  UserNotFoundException,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthenticationError, CognitoService } from "../../apps/api/src/services/cognito.service.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const service = new CognitoService(cognito as unknown as CognitoIdentityProviderClient, "pool-id", "client-id");
const EMAIL = "luiz@example.com";
const TOKEN = "ab".repeat(32);

describe("CognitoService", () => {
  beforeEach(() => cognito.reset());

  describe("ensureUser", () => {
    it("creates the user without sending Cognito's own email", async () => {
      cognito.on(AdminCreateUserCommand).resolves({});
      await service.ensureUser(EMAIL);

      expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input).toEqual({
        UserPoolId: "pool-id",
        Username: EMAIL,
        MessageAction: "SUPPRESS",
        UserAttributes: [{ Name: "email", Value: EMAIL }],
      });
    });

    it("confirms a new user with a random, unshared permanent password", async () => {
      cognito.on(AdminCreateUserCommand).resolves({});
      cognito.on(AdminSetUserPasswordCommand).resolves({});
      await service.ensureUser(EMAIL);
      await service.ensureUser("other@example.com");

      const [first, second] = cognito.commandCalls(AdminSetUserPasswordCommand).map((call) => call.args[0].input);
      expect(first).toMatchObject({ UserPoolId: "pool-id", Username: EMAIL, Permanent: true });
      expect(first?.Password).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\w]).{40,}$/);
      expect(first?.Password).not.toBe(second?.Password);
    });

    it("is idempotent for existing users and leaves their account untouched", async () => {
      cognito.on(AdminCreateUserCommand).rejects(new UsernameExistsException({ message: "exists", $metadata: {} }));
      await expect(service.ensureUser(EMAIL)).resolves.toBeUndefined();
      expect(cognito.commandCalls(AdminSetUserPasswordCommand)).toHaveLength(0);
    });

    it("fails when the new user cannot be confirmed", async () => {
      cognito.on(AdminCreateUserCommand).resolves({});
      cognito.on(AdminSetUserPasswordCommand).rejects(new Error("password rejected"));
      await expect(service.ensureUser(EMAIL)).rejects.toThrow("password rejected");
    });

    it("propagates unexpected Cognito errors", async () => {
      cognito.on(AdminCreateUserCommand).rejects(new Error("throttled"));
      await expect(service.ensureUser(EMAIL)).rejects.toThrow("throttled");
    });
  });

  describe("signInWithMagicLink", () => {
    beforeEach(() => {
      cognito.on(InitiateAuthCommand).resolves({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "session-1",
        ChallengeParameters: { USERNAME: "sub-123", email: EMAIL },
      });
    });

    it("runs CUSTOM_AUTH and returns the JWTs", async () => {
      cognito.on(RespondToAuthChallengeCommand).resolves({
        AuthenticationResult: {
          IdToken: "id",
          AccessToken: "access",
          RefreshToken: "refresh",
          ExpiresIn: 3600,
          TokenType: "Bearer",
        },
      });

      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).resolves.toEqual({
        idToken: "id",
        accessToken: "access",
        refreshToken: "refresh",
        expiresIn: 3600,
        tokenType: "Bearer",
      });

      expect(cognito.commandCalls(InitiateAuthCommand)[0]!.args[0].input).toEqual({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: "client-id",
        AuthParameters: { USERNAME: EMAIL },
      });
      expect(cognito.commandCalls(RespondToAuthChallengeCommand)[0]!.args[0].input).toEqual({
        ClientId: "client-id",
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "session-1",
        ChallengeResponses: { USERNAME: "sub-123", ANSWER: TOKEN },
      });
    });

    it("fails when Cognito answers with another challenge (wrong token)", async () => {
      cognito.on(RespondToAuthChallengeCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "session-2" });
      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("maps NotAuthorizedException to AuthenticationError", async () => {
      cognito.on(RespondToAuthChallengeCommand).rejects(new NotAuthorizedException({ message: "no", $metadata: {} }));
      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("maps UserNotFoundException to AuthenticationError", async () => {
      cognito.on(InitiateAuthCommand).rejects(new UserNotFoundException({ message: "no user", $metadata: {} }));
      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("tolerates minimal Cognito responses", async () => {
      cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "session-1" });
      cognito.on(RespondToAuthChallengeCommand).resolves({ AuthenticationResult: { IdToken: "id", AccessToken: "a" } });

      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).resolves.toEqual({
        idToken: "id",
        accessToken: "a",
        refreshToken: undefined,
        expiresIn: 3600,
        tokenType: "Bearer",
      });
      expect(cognito.commandCalls(RespondToAuthChallengeCommand)[0]?.args[0].input.ChallengeResponses?.USERNAME).toBe(
        EMAIL,
      );
    });

    it("rejects a custom challenge without a session", async () => {
      cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE" });
      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).rejects.toBeInstanceOf(AuthenticationError);
      expect(cognito.commandCalls(RespondToAuthChallengeCommand)).toHaveLength(0);
    });

    it("rejects unexpected challenge types", async () => {
      cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "SMS_MFA", Session: "s" });
      await expect(service.signInWithMagicLink(EMAIL, TOKEN)).rejects.toBeInstanceOf(AuthenticationError);
      expect(cognito.commandCalls(RespondToAuthChallengeCommand)).toHaveLength(0);
    });
  });
});
