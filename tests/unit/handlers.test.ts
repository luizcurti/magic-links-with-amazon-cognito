import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as verifyHandler } from "../../apps/api/src/handlers/auth-callback.js";
import { GENERIC_RESPONSE, handler as loginHandler } from "../../apps/api/src/handlers/login.js";
import { handler as meHandler } from "../../apps/api/src/handlers/me.js";
import { hashToken } from "../../apps/api/src/services/token.service.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const dynamo = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESClient);

const TOKEN = "ab".repeat(32);

const request = (body: unknown, extra: Partial<APIGatewayProxyEvent> = {}) =>
  ({
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    ...extra,
  }) as APIGatewayProxyEvent;

const invoke = async (handler: typeof loginHandler, event: APIGatewayProxyEvent) =>
  (await handler(event, {} as Context, () => undefined)) as APIGatewayProxyResult;

beforeEach(() => {
  cognito.reset();
  dynamo.reset();
  ses.reset();
  Object.assign(process.env, {
    USER_POOL_ID: "pool-id",
    USER_POOL_CLIENT_ID: "client-id",
    MAGIC_LINKS_TABLE: "magic-links",
    SES_FROM_ADDRESS: "no-reply@magic-links.local",
    MAGIC_LINK_CALLBACK_URL: "http://localhost:5173/auth/callback",
    MAGIC_LINK_TTL_SECONDS: "600",
  });
});

describe("POST /login", () => {
  it("normalises the email, stores the hash and sends the email", async () => {
    cognito.on(AdminCreateUserCommand).resolves({});
    dynamo.on(PutCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "1" });

    const response = await invoke(loginHandler, request({ email: "  Luiz@Example.COM " }));

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual(GENERIC_RESPONSE);

    const item = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item.email).toBe("luiz@example.com");

    const email = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(email.Destination?.ToAddresses).toEqual(["luiz@example.com"]);
    expect(email.Source).toBe("no-reply@magic-links.local");

    const token = email.Message!.Body!.Text!.Data!.match(/token=([0-9a-f]{64})/)![1]!;
    expect(item.tokenHash).toBe(hashToken(token));
  });

  it.each([
    ["missing body", undefined],
    ["invalid JSON", "{nope"],
    ["missing email", {}],
    ["invalid email", { email: "not-an-email" }],
  ])("returns 400 for %s", async (_label, body) => {
    const event = body === undefined ? ({ body: null } as unknown as APIGatewayProxyEvent) : request(body);
    const response = await invoke(loginHandler, event);
    expect(response.statusCode).toBe(400);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("returns 500 without leaking internals when AWS fails", async () => {
    cognito.on(AdminCreateUserCommand).resolves({});
    dynamo.on(PutCommand).rejects(new Error("DynamoDB is down"));

    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("DynamoDB");
  });

  it("answers exactly the same during the cooldown, without sending another email", async () => {
    cognito.on(AdminCreateUserCommand).rejects(new UsernameExistsException({ message: "exists", $metadata: {} }));
    dynamo.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "recent link", $metadata: {} }));

    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }));

    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual(GENERIC_RESPONSE);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("accepts a base64-encoded body", async () => {
    cognito.on(AdminCreateUserCommand).resolves({});
    dynamo.on(PutCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "1" });

    const body = Buffer.from(JSON.stringify({ email: "luiz@example.com" })).toString("base64");
    const response = await invoke(loginHandler, request(body, { isBase64Encoded: true }));

    expect(response.statusCode).toBe(202);
  });

  it("does not store a link when the Cognito user cannot be created", async () => {
    cognito.on(AdminCreateUserCommand).rejects(new Error("Cognito is down"));

    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }));

    expect(response.statusCode).toBe(500);
    expect(dynamo.commandCalls(PutCommand)).toHaveLength(0);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
  });

  it("returns 500 when required configuration is missing", async () => {
    delete process.env.MAGIC_LINK_CALLBACK_URL;

    const response = await invoke(loginHandler, request({ email: "luiz@example.com" }));

    expect(response.statusCode).toBe(500);
    expect(cognito.commandCalls(AdminCreateUserCommand)).toHaveLength(0);
  });
});

describe("POST /auth/verify", () => {
  it("returns JWTs for a valid magic link", async () => {
    cognito
      .on(InitiateAuthCommand)
      .resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s", ChallengeParameters: { USERNAME: "sub" } });
    cognito
      .on(RespondToAuthChallengeCommand)
      .resolves({ AuthenticationResult: { IdToken: "id", AccessToken: "access", ExpiresIn: 3600 } });

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ idToken: "id", accessToken: "access" });
    expect(response.headers?.["Cache-Control"]).toBe("no-store");
  });

  it("returns 401 when Cognito rejects the link", async () => {
    cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s" });
    cognito.on(RespondToAuthChallengeCommand).rejects(new NotAuthorizedException({ message: "no", $metadata: {} }));

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));
    expect(response.statusCode).toBe(401);
  });

  it("returns 400 for a malformed token without calling Cognito", async () => {
    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: "123" }));
    expect(response.statusCode).toBe(400);
    expect(cognito.commandCalls(InitiateAuthCommand)).toHaveLength(0);
  });

  it("returns 500 without leaking internals when a Cognito trigger fails", async () => {
    cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s" });
    cognito
      .on(RespondToAuthChallengeCommand)
      .rejects(new Error("VerifyAuthChallengeResponse failed: DynamoDB timeout"));

    const response = await invoke(verifyHandler, request({ email: "luiz@example.com", token: TOKEN }));

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("DynamoDB");
  });
});

describe("GET /me", () => {
  it("returns the verified claims forwarded by the Cognito authorizer", async () => {
    const event = {
      requestContext: { authorizer: { claims: { sub: "sub-1", email: "luiz@example.com", auth_time: "1", exp: "2" } } },
    } as unknown as APIGatewayProxyEvent;

    const response = await invoke(meHandler, event);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      sub: "sub-1",
      email: "luiz@example.com",
      authTime: "1",
      expiresAt: "2",
    });
  });

  it("returns 401 without claims", async () => {
    const response = await invoke(meHandler, { requestContext: {} } as unknown as APIGatewayProxyEvent);
    expect(response.statusCode).toBe(401);
  });
});
