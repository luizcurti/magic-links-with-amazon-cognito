/**
 * Tests against the real stack running on LocalStack:
 * API Gateway -> Lambda -> DynamoDB / SES / Cognito custom auth triggers.
 *
 * Prerequisites: make up && make infra
 */
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  InitiateAuthCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../apps/api/src/services/token.service.js";
import {
  countEmails,
  isLocalStackUp,
  LOCALSTACK_ENDPOINT,
  latestMagicLink,
  linkParams,
  loadStack,
  post,
  uniqueEmail,
  waitForMagicLink,
  waitForQueueDrained,
} from "./stack.js";

const stack = loadStack();
const ready = stack !== undefined && (await isLocalStackUp());

if (!ready) {
  console.warn("⚠ Skipping integration tests: run `make up && make infra` first.");
}

const awsConfig = {
  endpoint: LOCALSTACK_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));
const cognito = new CognitoIdentityProviderClient(awsConfig);
const sqs = new SQSClient(awsConfig);

const apiUrl = stack?.apiUrl ?? "";
/**
 * Requests a link for `typedEmail` (what the user typed) and returns the token
 * from the email delivered to `mailbox` (the normalized address).
 */
async function requestLink(typedEmail: string, mailbox = typedEmail) {
  const sentAfter = new Date(Date.now() - 1_000);
  const previous = await latestMagicLink(mailbox);
  const response = await post(`${apiUrl}/login`, { email: typedEmail });
  expect(response.status).toBe(202);

  const link = await waitForMagicLink(mailbox, sentAfter, 10_000, previous);
  return { token: linkParams(link).get("token") ?? "", link };
}

/** Moves a stored link back in time, as if `seconds` had passed. */
async function ageLink(email: string, attribute: "createdAt" | "expiresAt", seconds: number) {
  await dynamo.send(
    new UpdateCommand({
      TableName: stack?.tableName,
      Key: { pk: `EMAIL#${email}` },
      UpdateExpression: `SET ${attribute} = ${attribute} - :seconds`,
      ExpressionAttributeValues: { ":seconds": seconds },
    }),
  );
}

const verify = (email: string, token: string) => post(`${apiUrl}/auth/verify`, { email, token });

/** Signs in end to end and returns the Cognito tokens. */
async function signIn(label: string) {
  const email = uniqueEmail(label);
  const { token } = await requestLink(email);
  const { body } = await verify(email, token);
  return body;
}

/** Tries to mint new tokens from a refresh token, as a client would. */
const refresh = (refreshToken: string) =>
  cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: stack?.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );

describe.runIf(ready)("magic link flow (LocalStack)", { timeout: 60_000 }, () => {
  describe("happy path", () => {
    it("login -> email -> JWT -> /me", async () => {
      const email = uniqueEmail("success");
      const { token, link } = await requestLink(email);

      expect(link.origin + link.pathname).toBe("http://localhost:5173/auth/callback");

      const response = await verify(email, token);
      expect(response.status).toBe(200);
      expect(response.body.idToken?.split(".")).toHaveLength(3);
      expect(response.body.accessToken).toBeTruthy();
      expect(response.body.refreshToken).toBeTruthy();

      const me = await fetch(`${apiUrl}/me`, { headers: { Authorization: response.body.idToken ?? "" } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ email });
    });

    it("puts the link in the URL fragment, which browsers never send to a server", async () => {
      const email = uniqueEmail("fragment");
      const { link } = await requestLink(email);

      expect(link.search).toBe("");
      expect(linkParams(link).get("email")).toBe(email);
    });

    it("creates the Cognito user only once the link is used, CONFIRMED so real Cognito lets it sign in", async () => {
      const email = uniqueEmail("confirmed");
      const { token } = await requestLink(email);
      const getUser = () => cognito.send(new AdminGetUserCommand({ UserPoolId: stack?.userPoolId, Username: email }));

      await expect(getUser()).rejects.toThrow(/not exist|not found/i);

      expect((await verify(email, token)).status).toBe(200);
      expect((await getUser()).UserStatus).toBe("CONFIRMED");
    });

    it("marks the email verified, and /me says so", async () => {
      const { idToken = "" } = await signIn("verified");

      const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
      expect(claims.email_verified).toBe("true");
      const me = await fetch(`${apiUrl}/me`, { headers: { Authorization: idToken } });
      expect(await me.json()).toMatchObject({ emailVerified: true });
    });

    it("stores only the SHA-256 hash of the token", async () => {
      const email = uniqueEmail("hash");
      const { token } = await requestLink(email);

      const { Item } = await dynamo.send(
        new GetCommand({ TableName: stack?.tableName, Key: { pk: `EMAIL#${email}` } }),
      );

      expect(Item).toMatchObject({ email, tokenHash: hashToken(token), used: false });
      expect(JSON.stringify(Item)).not.toContain(token);
    });

    it("treats the email case-insensitively", async () => {
      const email = uniqueEmail("case");
      const { token } = await requestLink(`  ${email.toUpperCase()} `, email);

      expect(
        (
          await verify(
            email.replace(/^./, (c) => c.toUpperCase()),
            token,
          )
        ).status,
      ).toBe(200);
    });

    it("repairs a user an earlier failed request left in FORCE_CHANGE_PASSWORD", async () => {
      const email = uniqueEmail("stuck");
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: stack?.userPoolId,
          Username: email,
          MessageAction: "SUPPRESS",
          UserAttributes: [{ Name: "email", Value: email }],
        }),
      );

      const { token } = await requestLink(email);
      expect((await verify(email, token)).status).toBe(200);

      const user = await cognito.send(new AdminGetUserCommand({ UserPoolId: stack?.userPoolId, Username: email }));
      expect(user.UserStatus).toBe("CONFIRMED");
    });

    it("sign-out revokes the refresh token and is idempotent", async () => {
      const { refreshToken = "" } = await signIn("logout");
      await expect(refresh(refreshToken)).resolves.toHaveProperty("AuthenticationResult.AccessToken");

      const first = await post(`${apiUrl}/logout`, { refreshToken });
      const second = await post(`${apiUrl}/logout`, { refreshToken });

      expect([first.status, second.status]).toEqual([204, 204]);
      await expect(refresh(refreshToken)).rejects.toThrow(/revoked/i);
    });

    it("issues ID and access tokens that live 15 minutes", async () => {
      const { idToken = "", accessToken = "", expiresIn } = await signIn("lifetime");
      const lifetime = (jwt: string) => {
        const { exp, iat } = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
        return exp - iat;
      };

      expect(Number(expiresIn)).toBe(900);
      expect(lifetime(idToken)).toBe(900);
      expect(lifetime(accessToken)).toBe(900);
    });

    it("renews the session with the refresh token, and the new ID token works on /me", async () => {
      const { refreshToken = "", idToken = "" } = await signIn("renew");

      const renewed = await post(`${apiUrl}/auth/refresh`, { refreshToken });

      expect(renewed.status).toBe(200);
      expect(renewed.body.idToken).toBeTruthy();
      expect(renewed.body.idToken).not.toBe(idToken);
      expect(renewed.body.refreshToken).toBeUndefined();
      expect((await fetch(`${apiUrl}/me`, { headers: { Authorization: renewed.body.idToken ?? "" } })).status).toBe(
        200,
      );
    });

    it("after sign-out the session can no longer be renewed", async () => {
      const { refreshToken = "" } = await signIn("renew-after-logout");
      await post(`${apiUrl}/logout`, { refreshToken });

      const response = await post(`${apiUrl}/auth/refresh`, { refreshToken });
      expect(response).toEqual({ status: 401, body: { message: "Session expired or revoked" } });
    });

    it("known limit: the ID token keeps working on /me until it expires (max 15 min), even after sign-out", async () => {
      const { idToken = "", refreshToken = "" } = await signIn("stateless");
      await post(`${apiUrl}/logout`, { refreshToken });

      // API Gateway checks the JWT signature and expiry, not Cognito revocation;
      // short token lifetimes bound this window.
      expect((await fetch(`${apiUrl}/me`, { headers: { Authorization: idToken } })).status).toBe(200);
    });

    it("lets a returning user sign in again with a new link", async () => {
      const email = uniqueEmail("returning");
      const first = await requestLink(email);
      expect((await verify(email, first.token)).status).toBe(200);

      const second = await requestLink(email);
      expect((await verify(email, second.token)).status).toBe(200);
    });
  });

  describe("sad path", () => {
    it("a link works only once", async () => {
      const email = uniqueEmail("reuse");
      const { token } = await requestLink(email);

      expect((await verify(email, token)).status).toBe(200);
      expect((await verify(email, token)).status).toBe(401);
    });

    it("parallel clicks on the same link: exactly one wins", async () => {
      const email = uniqueEmail("race");
      const { token } = await requestLink(email);

      const statuses = (await Promise.all(Array.from({ length: 5 }, () => verify(email, token)))).map((r) => r.status);

      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 401)).toHaveLength(4);
    });

    it("a wrong token is rejected and does not burn the real one", async () => {
      const email = uniqueEmail("invalid");
      const { token } = await requestLink(email);

      const response = await verify(email, "0".repeat(64));
      expect(response).toEqual({ status: 401, body: { message: "Invalid or expired magic link" } });
      expect((await verify(email, token)).status).toBe(200);
    });

    it("a token cannot authenticate another account", async () => {
      const victim = uniqueEmail("victim");
      const attacker = uniqueEmail("attacker");
      const { token } = await requestLink(victim);
      await requestLink(attacker);

      expect((await verify(attacker, token)).status).toBe(401);
      expect((await verify(victim, token)).status).toBe(200);
    });

    it("a bad link creates no Cognito user", async () => {
      const email = uniqueEmail("no-user");
      await requestLink(email);

      expect((await verify(email, "0".repeat(64))).status).toBe(401);
      await expect(
        cognito.send(new AdminGetUserCommand({ UserPoolId: stack?.userPoolId, Username: email })),
      ).rejects.toThrow(/not exist|not found/i);
    });

    it("an email without an account gets the same 401", async () => {
      const response = await verify(uniqueEmail("ghost"), "a".repeat(64));
      expect(response).toEqual({ status: 401, body: { message: "Invalid or expired magic link" } });
    });

    it("an expired link is rejected", async () => {
      const email = uniqueEmail("expired");
      const { token } = await requestLink(email);
      await ageLink(email, "expiresAt", 601);

      expect((await verify(email, token)).status).toBe(401);
    });

    it("a new link invalidates the previous one", async () => {
      const email = uniqueEmail("rotate");
      const first = await requestLink(email);
      await ageLink(email, "createdAt", 61);
      const second = await requestLink(email);

      expect((await verify(email, first.token)).status).toBe(401);
      expect((await verify(email, second.token)).status).toBe(200);
    });

    it("a late request (SQS retry or duplicate) never replaces a newer link", async () => {
      const email = uniqueEmail("late");
      const { token } = await requestLink(email);
      await ageLink(email, "createdAt", 61); // past the cooldown: on its own, it would allow a new link

      // Replay a request made before that link straight into the queue, as a late retry would.
      const { Item } = await dynamo.send(
        new GetCommand({ TableName: stack?.tableName, Key: { pk: `EMAIL#${email}` } }),
      );
      const askedBeforeTheLink = (Item?.createdAt as number) - 5;
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: stack?.loginQueueUrl,
          MessageBody: JSON.stringify({ email, requestedAt: askedBeforeTheLink }),
        }),
      );

      await waitForQueueDrained(stack?.loginQueueUrl ?? "");
      expect(await countEmails(email)).toBe(1);
      expect((await verify(email, token)).status).toBe(200);
    });

    it("email bombing: repeated requests inside the cooldown send a single email", async () => {
      const email = uniqueEmail("bomb");
      const { token } = await requestLink(email);

      const responses = await Promise.all(Array.from({ length: 3 }, () => post(`${apiUrl}/login`, { email })));
      expect(responses.every((r) => r.status === 202)).toBe(true);

      // Sending is asynchronous (SQS worker): wait until every request was processed.
      await waitForQueueDrained(stack?.loginQueueUrl ?? "");
      expect(await countEmails(email)).toBe(1);
      expect((await verify(email, token)).status).toBe(200);
    });

    it("same response for new and existing users (no enumeration)", async () => {
      const email = uniqueEmail("enum");
      const first = await post(`${apiUrl}/login`, { email });
      const second = await post(`${apiUrl}/login`, { email });

      expect(first).toEqual(second);
    });

    // Real Cognito runs the triggers for unknown users too (userNotFound = true),
    // and they answer with a decoy challenge. LocalStack rejects unknown users
    // before any trigger runs, so that half is covered by the unit tests only.
    it("calling Cognito directly: the challenge does not echo the user's email", async () => {
      const email = uniqueEmail("enum-direct");
      const { token } = await requestLink(email);
      await verify(email, token); // the Cognito user exists from the first sign-in on

      const challenge = await cognito.send(
        new InitiateAuthCommand({
          AuthFlow: "CUSTOM_AUTH",
          ClientId: stack?.clientId,
          AuthParameters: { USERNAME: email },
        }),
      );

      expect(challenge.ChallengeName).toBe("CUSTOM_CHALLENGE");
      expect(challenge.ChallengeParameters).not.toHaveProperty("email");
    });

    // Real Cognito rejects UpdateUserAttributes on an attribute the app client
    // cannot write; LocalStack does not enforce write_attributes, so the
    // configuration itself is what can be checked here.
    it("the app client cannot write the email, so users cannot take over another address", async () => {
      const { UserPoolClient } = await cognito.send(
        new DescribeUserPoolClientCommand({ UserPoolId: stack?.userPoolId, ClientId: stack?.clientId }),
      );

      expect(UserPoolClient?.WriteAttributes?.length).toBeGreaterThan(0); // empty means "all attributes"
      expect(UserPoolClient?.WriteAttributes).not.toContain("email");
      expect(UserPoolClient?.WriteAttributes).not.toContain("email_verified");
    });

    it.each([
      ["invalid email", "/login", { email: "nope" }],
      ["null body", "/login", null],
      ["array body", "/login", []],
      ["short token", "/auth/verify", { email: "a@b.com", token: "short" }],
      ["uppercase token", "/auth/verify", { email: "a@b.com", token: "A".repeat(64) }],
    ])("rejects %s with 400", async (_label, path, body) => {
      const response = await post(`${apiUrl}${path}`, body);
      expect(response.status).toBe(400);
      expect(response.body.message).toBeTruthy();
    });

    it("rejects a body that is not JSON with 400", async () => {
      const response = await fetch(`${apiUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{nope",
      });
      expect(response.status).toBe(400);
    });

    it("rejects a body not declared as JSON with 415, so web pages cannot post it cross-site without CORS", async () => {
      const email = uniqueEmail("text-plain");
      const response = await fetch(`${apiUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ email }),
      });

      expect(response.status).toBe(415);
      await waitForQueueDrained(stack?.loginQueueUrl ?? "");
      expect(await countEmails(email)).toBe(0);
    });

    it.each([
      ["no token", undefined],
      ["forged token", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.invalid"],
    ])("protects /me: %s -> 401", async (_label, authorization) => {
      const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
      expect((await fetch(`${apiUrl}/me`, { headers })).status).toBe(401);
    });

    it("protects /me: a real ID token with a tampered payload -> 401 (LocalStack's authorizer lets it through; the Lambda does not)", async () => {
      const { idToken = "" } = await signIn("tampered-jwt");
      const [header, payload, signature] = idToken.split(".");
      const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
      const forged = Buffer.from(JSON.stringify({ ...claims, sub: "someone-else", email: "ceo@example.com" })).toString(
        "base64url",
      );

      const response = await fetch(`${apiUrl}/me`, { headers: { Authorization: `${header}.${forged}.${signature}` } });
      expect(response.status).toBe(401);
    });

    it("protects /me: an access token is not an ID token -> 401", async () => {
      const email = uniqueEmail("access");
      const { token } = await requestLink(email);
      const { body } = await verify(email, token);

      expect((await fetch(`${apiUrl}/me`, { headers: { Authorization: body.accessToken ?? "" } })).status).toBe(401);
    });

    it.each([
      ["missing token", {}],
      ["empty token", { refreshToken: "" }],
      ["token that is not a string", { refreshToken: 42 }],
    ])("rejects a sign-out or refresh with a %s with 400", async (_label, body) => {
      expect((await post(`${apiUrl}/logout`, body)).status).toBe(400);
      expect((await post(`${apiUrl}/auth/refresh`, body)).status).toBe(400);
    });

    it("refuses to renew with a refresh token Cognito never issued", async () => {
      expect((await post(`${apiUrl}/auth/refresh`, { refreshToken: "forged.refresh.token" })).status).toBe(401);
    });

    it("a burst of parallel logins is absorbed without taking the stack down", { timeout: 120_000 }, async () => {
      const responses = await Promise.all(
        Array.from({ length: 30 }, (_, i) => post(`${apiUrl}/login`, { email: uniqueEmail(`burst${i}`) })),
      );

      expect(responses.map((r) => r.status).every((s) => s === 202)).toBe(true);
      expect(await isLocalStackUp()).toBe(true);
    });

    it("unknown routes and methods are not exposed", async () => {
      expect((await fetch(`${apiUrl}/login`)).status).toBe(403);
      expect((await fetch(`${apiUrl}/logout`)).status).toBe(403);
      expect((await fetch(`${apiUrl}/auth/refresh`)).status).toBe(403);
      expect((await post(`${apiUrl}/admin`, {})).status).toBe(403);
    });
  });
});
