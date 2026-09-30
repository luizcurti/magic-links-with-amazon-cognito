import { sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  TooManyRequestsException,
  UnauthorizedException,
  UserNotFoundException,
} from "@aws-sdk/client-cognito-identity-provider";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as verifyHandler } from "../../apps/api/src/handlers/auth-callback.js";
import { GENERIC_RESPONSE, handler as loginHandler } from "../../apps/api/src/handlers/login.js";
import { handler as logoutHandler } from "../../apps/api/src/handlers/logout.js";
import { handler as meHandler } from "../../apps/api/src/handlers/me.js";
import { handler as refreshHandler } from "../../apps/api/src/handlers/refresh.js";
import { handler as sendMagicLinkHandler } from "../../apps/api/src/handlers/send-magic-link.js";
import { idTokenVerifier, resetIdTokenVerifier } from "../../apps/api/src/lib/id-token.js";
import { hashToken } from "../../apps/api/src/services/token.service.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const dynamo = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESClient);
const sqs = mockClient(SQSClient);

const TOKEN = "ab".repeat(32);
const NOW_S = Math.floor(Date.now() / 1000);

const request = (body: unknown, extra: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    isBase64Encoded: false,
    ...extra,
  }) as APIGatewayProxyEvent;

const invoke = async (handler: typeof loginHandler, event: APIGatewayProxyEvent) =>
  (await handler(event, {} as Context, () => undefined)) as APIGatewayProxyResult;

const sqsEvent = (...bodies: string[]) =>
  ({ Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) }) as unknown as SQSEvent;

const runWorker = async (event: SQSEvent) =>
  (await sendMagicLinkHandler(event, {} as Context, () => undefined)) as SQSBatchResponse;

/** A stored, unused link for TOKEN, as the worker would have written it. */
const storedLink = (overrides: Record<string, unknown> = {}) => ({
  Item: {
    pk: "EMAIL#luiz@example.com",
    email: "luiz@example.com",
    tokenHash: hashToken(TOKEN),
    createdAt: NOW_S,
    expiresAt: NOW_S + 600,
    used: false,
    ...overrides,
  },
});

beforeEach(() => {
  cognito.reset();
  dynamo.reset();
  ses.reset();
  sqs.reset();
  Object.assign(process.env, {
    USER_POOL_ID: "pool-id",
    USER_POOL_CLIENT_ID: "client-id",
    MAGIC_LINKS_TABLE: "magic-links",
    LOGIN_QUEUE_URL: "http://sqs/login-requests",
    SES_FROM_ADDRESS: "no-reply@magic-links.local",
    MAGIC_LINK_CALLBACK_URL: "http://localhost:5173/auth/callback",
    MAGIC_LINK_TTL_SECONDS: "600",
  });
});

describe("POST /login", () => {
  it("normalises the email and queues it, and does nothing else", async () => {
    sqs.on(SendMessageCommand).resolves({ MessageId: "1" });

    const response = await invoke(loginHandler, request({ email: "  Luiz@Example.COM " }));

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual(GENERIC_RESPONSE);
    const message = sqs.commandCalls(SendMessageCommand)[0]!.args[0].input;
    expect(message.QueueUrl).toBe("http://sqs/login-requests");
    const body = JSON.parse(message.MessageBody ?? "");
    expect(body.email).toBe("luiz@example.com");
    expect(Math.abs(body.requestedAt - NOW_S)).toBeLessThanOrEqual(2);
    // No per-email work: no Cognito user, no stored link, no email yet.
    expect(cognito.calls()).toHaveLength(0);
    expect(dynamo.calls()).toHaveLength(0);
    expect(ses.calls()).toHaveLength(0);
  });

  it.each([
    ["missing body", undefined],
    ["invalid JSON", "{nope"],
    ["missing email", {}],
    ["invalid email", { email: "not-an-email" }],
  ])("returns 400 for %s", async (_label, body) => {
    const event = body === undefined ? request(null, { body: null }) : request(body);
    const response = await invoke(loginHandler, event);
    expect(response.statusCode).toBe(400);
    expect(sqs.calls()).toHaveLength(0);
  });

  it.each([
    ["text/plain (sent cross-site without a CORS preflight)", { "Content-Type": "text/plain" }],
    ["a form body", { "content-type": "application/x-www-form-urlencoded" }],
    ["no Content-Type", {}],
  ])("returns 415 for %s", async (_label, headers) => {
    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }, { headers }));
    expect(response.statusCode).toBe(415);
    expect(sqs.calls()).toHaveLength(0);
  });

  it("returns 415 when the request has no headers at all", async () => {
    const event = request(
      { email: "luiz@example.com" },
      { headers: null as unknown as APIGatewayProxyEvent["headers"] },
    );
    expect((await invoke(loginHandler, event)).statusCode).toBe(415);
  });

  it("accepts a JSON Content-Type with parameters, in any case", async () => {
    sqs.on(SendMessageCommand).resolves({});
    const headers = { "content-type": "Application/JSON; charset=utf-8" };
    expect((await invoke(loginHandler, request({ email: "luiz@example.com" }, { headers }))).statusCode).toBe(202);
  });

  it("accepts a base64-encoded body", async () => {
    sqs.on(SendMessageCommand).resolves({});
    const body = Buffer.from(JSON.stringify({ email: "luiz@example.com" })).toString("base64");
    expect((await invoke(loginHandler, request(body, { isBase64Encoded: true }))).statusCode).toBe(202);
  });

  it("returns 500 without leaking internals when the queue fails", async () => {
    sqs.on(SendMessageCommand).rejects(new Error("SQS is down"));

    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("SQS");
  });

  it("returns 429 with Retry-After when SQS keeps throttling", async () => {
    sqs.on(SendMessageCommand).rejects(Object.assign(new Error("slow down"), { name: "RequestThrottled" }));

    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }));
    expect(response.statusCode).toBe(429);
    expect(response.headers?.["Retry-After"]).toBe("5");
  });

  it("returns 500 when required configuration is missing", async () => {
    delete process.env.LOGIN_QUEUE_URL;
    expect((await invoke(loginHandler, request({ email: "luiz@example.com" }))).statusCode).toBe(500);
  });
});

describe("send-magic-link worker", () => {
  const request = (body: Record<string, unknown>) => sqsEvent(JSON.stringify(body));

  beforeEach(() => {
    dynamo.on(GetCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
  });

  it("stores the hash, emails the link and records the delivery", async () => {
    dynamo.on(PutCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "1" });

    const result = await runWorker(request({ email: "luiz@example.com" }));

    expect(result.batchItemFailures).toEqual([]);
    const item = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    const email = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(email.Destination?.ToAddresses).toEqual(["luiz@example.com"]);
    expect(email.Source).toBe("no-reply@magic-links.local");
    const token = email.Message!.Body!.Text!.Data!.match(/token=([0-9a-f]{64})/)![1]!;
    expect(item.tokenHash).toBe(hashToken(token));
    expect(item.requestId).toBe("m0");
    expect(dynamo.commandCalls(UpdateCommand)[0]!.args[0].input.UpdateExpression).toBe("SET deliveredAt = :now");
  });

  it("does not replace a link created after the request was made", async () => {
    dynamo.on(GetCommand).resolves(storedLink({ createdAt: 2000 }));

    const result = await runWorker(request({ email: "luiz@example.com", requestedAt: 1234 }));

    expect(result.batchItemFailures).toEqual([]);
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(0);
    expect(ses.calls()).toHaveLength(0);
  });

  it("sends nothing during the cooldown, and does not retry", async () => {
    dynamo.on(GetCommand).resolves(storedLink({ createdAt: NOW_S }));

    const result = await runWorker(request({ email: "luiz@example.com" }));

    expect(result.batchItemFailures).toEqual([]);
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(0);
    expect(ses.calls()).toHaveLength(0);
  });

  it("sends nothing when a parallel request stored its link first", async () => {
    dynamo.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "changed", $metadata: {} }));

    const result = await runWorker(request({ email: "luiz@example.com" }));

    expect(result.batchItemFailures).toEqual([]);
    expect(ses.calls()).toHaveLength(0);
  });

  it("drops the undelivered link and asks SQS to retry when SES fails", async () => {
    dynamo.on(PutCommand).resolves({});
    dynamo.on(DeleteCommand).resolves({});
    ses.on(SendEmailCommand).rejects(new Error("SES is down"));

    const result = await runWorker(request({ email: "luiz@example.com" }));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    const stored = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(dynamo.commandCalls(DeleteCommand)[0]!.args[0].input.ExpressionAttributeValues?.[":hash"]).toBe(
      stored.tokenHash,
    );
  });

  it("processes a batch in parallel and retries only the failed messages", async () => {
    dynamo.on(PutCommand).resolves({});
    dynamo.on(DeleteCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "2" });
    ses.on(SendEmailCommand, { Destination: { ToAddresses: ["a@example.com"] } }).rejects(new Error("SES is down"));

    const result = await runWorker(
      sqsEvent(JSON.stringify({ email: "a@example.com" }), JSON.stringify({ email: "b@example.com" })),
    );

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    expect(ses.calls()).toHaveLength(2);
  });

  it.each([
    ["not JSON", "{nope"],
    ["no email", "{}"],
    ["invalid email", JSON.stringify({ email: "nope" })],
  ])("drops a malformed message (%s) without retrying", async (_label, body) => {
    const result = await runWorker(sqsEvent(body));
    expect(result.batchItemFailures).toEqual([]);
    expect(dynamo.calls()).toHaveLength(0);
  });
});

describe("POST /auth/verify", () => {
  const signInSucceeds = () => {
    cognito.on(AdminGetUserCommand).rejects(new UserNotFoundException({ message: "no such user", $metadata: {} }));
    cognito.on(AdminCreateUserCommand).resolves({});
    cognito
      .on(InitiateAuthCommand)
      .resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s", ChallengeParameters: { USERNAME: "sub" } });
    cognito
      .on(RespondToAuthChallengeCommand)
      .resolves({ AuthenticationResult: { IdToken: "id", AccessToken: "access", ExpiresIn: 3600 } });
  };

  it("returns JWTs for a valid magic link, creating the user only now", async () => {
    dynamo.on(GetCommand).resolves(storedLink());
    signInSucceeds();

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ idToken: "id", accessToken: "access" });
    expect(response.headers?.["Cache-Control"]).toBe("no-store");
    expect(cognito.commandCalls(AdminCreateUserCommand)[0]!.args[0].input.Username).toBe("luiz@example.com");
  });

  it.each([
    ["an unknown link", {}],
    ["a wrong token", storedLink({ tokenHash: hashToken("cd".repeat(32)) })],
    ["a used link", storedLink({ used: true })],
    ["an expired link", storedLink({ expiresAt: NOW_S - 1 })],
  ])("turns away %s with 401 without calling Cognito", async (_label, stored) => {
    dynamo.on(GetCommand).resolves(stored);

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ message: "Invalid or expired magic link" });
    expect(cognito.calls()).toHaveLength(0);
  });

  it("returns 401 when Cognito rejects the link (e.g. consumed by a parallel click)", async () => {
    dynamo.on(GetCommand).resolves(storedLink());
    cognito.on(AdminGetUserCommand).resolves({ UserStatus: "CONFIRMED" });
    cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s" });
    cognito.on(RespondToAuthChallengeCommand).rejects(new NotAuthorizedException({ message: "no", $metadata: {} }));

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for a malformed token without touching the table or Cognito", async () => {
    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: "123" }));
    expect(response.statusCode).toBe(400);
    expect(dynamo.calls()).toHaveLength(0);
    expect(cognito.calls()).toHaveLength(0);
  });

  it("returns 415 for a body that is not declared as JSON", async () => {
    const headers = { "Content-Type": "text/plain" };
    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }, { headers }));
    expect(response.statusCode).toBe(415);
  });

  it("returns 429 when Cognito throttles, before the link is consumed", async () => {
    dynamo.on(GetCommand).resolves(storedLink());
    cognito.on(AdminGetUserCommand).resolves({ UserStatus: "CONFIRMED" });
    cognito.on(InitiateAuthCommand).rejects(new TooManyRequestsException({ message: "slow down", $metadata: {} }));

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));

    expect(response.statusCode).toBe(429);
    expect(cognito.commandCalls(RespondToAuthChallengeCommand)).toHaveLength(0);
  });

  it("returns 500 without leaking internals when a Cognito trigger fails", async () => {
    dynamo.on(GetCommand).resolves(storedLink());
    cognito.on(AdminGetUserCommand).resolves({ UserStatus: "CONFIRMED" });
    cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s" });
    cognito
      .on(RespondToAuthChallengeCommand)
      .rejects(new Error("VerifyAuthChallengeResponse failed: DynamoDB timeout"));

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("DynamoDB");
  });
});

describe("POST /auth/refresh", () => {
  it("returns new short-lived tokens", async () => {
    cognito.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { IdToken: "id-2", AccessToken: "access-2", ExpiresIn: 900, TokenType: "Bearer" },
    });

    const response = await invoke(refreshHandler, request({ refreshToken: "refresh" }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      idToken: "id-2",
      accessToken: "access-2",
      expiresIn: 900,
      tokenType: "Bearer",
    });
    expect(response.headers?.["Cache-Control"]).toBe("no-store");
  });

  it("returns 401 once the refresh token is revoked", async () => {
    cognito
      .on(InitiateAuthCommand)
      .rejects(new NotAuthorizedException({ message: "Refresh Token has been revoked", $metadata: {} }));

    const response = await invoke(refreshHandler, request({ refreshToken: "revoked" }));

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ message: "Session expired or revoked" });
  });

  it("returns 400 without calling Cognito for a missing token", async () => {
    expect((await invoke(refreshHandler, request({}))).statusCode).toBe(400);
    expect(cognito.commandCalls(InitiateAuthCommand)).toHaveLength(0);
  });

  it("returns 429 when Cognito throttles", async () => {
    cognito.on(InitiateAuthCommand).rejects(new TooManyRequestsException({ message: "slow down", $metadata: {} }));
    expect((await invoke(refreshHandler, request({ refreshToken: "refresh" }))).statusCode).toBe(429);
  });

  it("returns 500 without leaking internals on other failures", async () => {
    cognito.on(InitiateAuthCommand).rejects(new Error("InternalErrorException: cognito exploded"));
    const response = await invoke(refreshHandler, request({ refreshToken: "refresh" }));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("exploded");
  });
});

describe("POST /logout", () => {
  it("revokes the refresh token and answers 204 with no body", async () => {
    cognito.on(RevokeTokenCommand).resolves({});

    const response = await invoke(logoutHandler, request({ refreshToken: "refresh" }));

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(cognito.commandCalls(RevokeTokenCommand)[0]?.args[0].input).toEqual({
      ClientId: "client-id",
      Token: "refresh",
    });
  });

  it("is idempotent for tokens Cognito does not recognise", async () => {
    cognito.on(RevokeTokenCommand).rejects(new UnauthorizedException({ message: "invalid", $metadata: {} }));
    expect((await invoke(logoutHandler, request({ refreshToken: "garbage" }))).statusCode).toBe(204);
  });

  it.each([
    ["missing token", {}],
    ["empty token", { refreshToken: "" }],
    ["oversized token", { refreshToken: "x".repeat(8193) }],
    ["token that is not a string", { refreshToken: 42 }],
  ])("returns 400 for a %s without calling Cognito", async (_label, body) => {
    expect((await invoke(logoutHandler, request(body))).statusCode).toBe(400);
    expect(cognito.commandCalls(RevokeTokenCommand)).toHaveLength(0);
  });

  it("returns 429 when Cognito throttles", async () => {
    cognito.on(RevokeTokenCommand).rejects(new TooManyRequestsException({ message: "slow down", $metadata: {} }));
    const response = await invoke(logoutHandler, request({ refreshToken: "refresh" }));
    expect(response.statusCode).toBe(429);
    expect(response.headers?.["Retry-After"]).toBe("5");
  });

  it("returns 500 without leaking internals on other failures", async () => {
    cognito.on(RevokeTokenCommand).rejects(new Error("UnsupportedOperationException: revocation disabled"));
    const response = await invoke(logoutHandler, request({ refreshToken: "refresh" }));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("revocation");
  });
});

describe("GET /me", () => {
  const ISSUER = "http://127.0.0.1:9/us-east-1_pool";
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...signingKey.publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256", use: "sig" };

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const nowS = () => Math.floor(Date.now() / 1000);
  const validClaims = () => ({
    sub: "sub-1",
    email: "luiz@example.com",
    email_verified: true,
    token_use: "id",
    iss: ISSUER,
    aud: "client-id",
    auth_time: nowS() - 10,
    iat: nowS() - 10,
    exp: nowS() + 900,
  });

  function sign(claims: Record<string, unknown>, { key = signingKey.privateKey, kid = "key-1" } = {}) {
    const unsigned = `${b64({ alg: "RS256", kid, typ: "JWT" })}.${b64(claims)}`;
    return `${unsigned}.${cryptoSign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
  }

  const callMe = (authorization?: string | null) =>
    invoke(meHandler, {
      headers: authorization === null ? null : authorization === undefined ? {} : { Authorization: authorization },
    } as unknown as APIGatewayProxyEvent);

  beforeEach(() => {
    process.env.ID_TOKEN_ISSUER = ISSUER;
    resetIdTokenVerifier();
    idTokenVerifier().cacheJwks({ keys: [jwk] } as never);
  });

  it("returns the claims of a valid ID token, verified here and not taken from the request context", async () => {
    const response = await callMe(sign(validClaims()));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ sub: "sub-1", email: "luiz@example.com", emailVerified: true });
    // Epoch seconds, as numbers: what the frontend's Profile type declares.
    expect(typeof body.authTime).toBe("number");
    expect(typeof body.expiresAt).toBe("number");
  });

  it("accepts a Bearer prefix, and email_verified as the string LocalStack uses", async () => {
    const response = await callMe(`Bearer ${sign({ ...validClaims(), email_verified: "true" })}`);
    expect(JSON.parse(response.body).emailVerified).toBe(true);
  });

  it("reports an email that was never verified", async () => {
    const response = await callMe(sign({ ...validClaims(), email_verified: "false" }));
    expect(JSON.parse(response.body).emailVerified).toBe(false);
  });

  it.each([
    ["no Authorization header", undefined],
    ["no headers at all", null],
    ["an empty Bearer", "Bearer "],
    ["garbage", "not-a-jwt"],
  ])("returns 401 for %s", async (_label, authorization) => {
    expect((await callMe(authorization)).statusCode).toBe(401);
  });

  it.each([
    [
      "a tampered payload with the original signature",
      () => {
        const [h, , sig] = sign(validClaims()).split(".");
        return `${h}.${b64({ ...validClaims(), sub: "someone-else" })}.${sig}`;
      },
    ],
    ["alg=none", () => `${b64({ alg: "none", typ: "JWT" })}.${b64(validClaims())}.`],
    ["a token signed with another key under the same kid", () => sign(validClaims(), { key: otherKey.privateKey })],
    ["an expired token", () => sign({ ...validClaims(), exp: nowS() - 1 })],
    ["another app client's token", () => sign({ ...validClaims(), aud: "other-client" })],
    ["another issuer's token", () => sign({ ...validClaims(), iss: "https://evil.example.com/pool" })],
    ["an access token", () => sign({ ...validClaims(), token_use: "access" })],
  ])("returns 401 for %s", async (_label, token) => {
    const response = await callMe(token());
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ message: "Unauthorized" });
  });

  it("answers 500, not 401, when the JWKS cannot be fetched, so a valid session is not dropped", async () => {
    resetIdTokenVerifier(); // nothing cached: the verifier must fetch 127.0.0.1:9, which refuses
    const response = await callMe(sign(validClaims()));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("127.0.0.1");
  });

  it("answers 500 for any other unexpected failure", async () => {
    vi.spyOn(idTokenVerifier(), "verify").mockRejectedValueOnce(new Error("boom"));
    expect((await callMe(sign(validClaims()))).statusCode).toBe(500);
  });
});
