/** Inputs and exact outputs (status, body, headers) of every route. */
import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  NotAuthorizedException,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  TooManyRequestsException,
  UnsupportedTokenTypeException,
} from "@aws-sdk/client-cognito-identity-provider";
import { ProvisionedThroughputExceededException } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { handler as verifyHandler } from "../../apps/api/src/handlers/auth-callback.js";
import { GENERIC_RESPONSE, handler as loginHandler } from "../../apps/api/src/handlers/login.js";
import { handler as logoutHandler } from "../../apps/api/src/handlers/logout.js";
import { handler as meHandler } from "../../apps/api/src/handlers/me.js";
import { handler as refreshHandler } from "../../apps/api/src/handlers/refresh.js";
import { handler as sendMagicLinkHandler } from "../../apps/api/src/handlers/send-magic-link.js";
import { hashToken } from "../../apps/api/src/services/token.service.js";

const cognito = mockClient(CognitoIdentityProviderClient);
const dynamo = mockClient(DynamoDBDocumentClient);
const ses = mockClient(SESClient);
const sqs = mockClient(SQSClient);

const TOKEN = "ab".repeat(32);
const EMAIL = "luiz@example.com";
const NOW_S = Math.floor(Date.now() / 1000);

type Handler = typeof loginHandler;

const event = (body: string | null, headers: Record<string, string> | null = { "Content-Type": "application/json" }) =>
  ({ body, headers, isBase64Encoded: false }) as unknown as APIGatewayProxyEvent;

const invoke = async (handler: Handler, e: APIGatewayProxyEvent) =>
  (await handler(e, {} as Context, () => undefined)) as APIGatewayProxyResult;

const send = (handler: Handler, body: unknown) => invoke(handler, event(JSON.stringify(body)));

/** Every response the Lambdas produce carries the same headers. */
function expectResponse(response: APIGatewayProxyResult, statusCode: number, body?: unknown) {
  expect(response.statusCode).toBe(statusCode);
  expect(response.headers).toMatchObject({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  });
  if (statusCode === 204) {
    expect(response.body).toBe("");
  } else {
    expect(JSON.parse(response.body)).toEqual(body);
  }
  if (statusCode === 429) expect(response.headers?.["Retry-After"]).toBe("5");
  else expect(response.headers).not.toHaveProperty("Retry-After");
}

const invalid = (...errors: [field: string, message: string][]) => ({
  message: "Invalid request",
  errors: errors.map(([field, message]) => ({ field, message })),
});

const storedLink = () => ({
  Item: {
    pk: `EMAIL#${EMAIL}`,
    email: EMAIL,
    tokenHash: hashToken(TOKEN),
    createdAt: NOW_S,
    expiresAt: NOW_S + 600,
    used: false,
  },
});

const COGNITO_TOKENS = { IdToken: "id", AccessToken: "access", RefreshToken: "refresh", ExpiresIn: 900 };

interface Route {
  handler: Handler;
  valid: Record<string, unknown>;
  /** Mocks the AWS calls of a successful request. */
  succeed: () => void;
  success: [status: number, body?: unknown];
  env: string[];
  /** Makes the route's first AWS dependency fail with `error`. */
  failWith: (error: Error) => void;
}

const ROUTES: Record<string, Route> = {
  "POST /login": {
    handler: loginHandler,
    valid: { email: EMAIL },
    succeed: () => sqs.on(SendMessageCommand).resolves({ MessageId: "1" }),
    success: [202, GENERIC_RESPONSE],
    env: ["LOGIN_QUEUE_URL"],
    failWith: (error) => sqs.on(SendMessageCommand).rejects(error),
  },
  "POST /auth/verify": {
    handler: verifyHandler,
    valid: { email: EMAIL, token: TOKEN },
    succeed: () => {
      dynamo.on(GetCommand).resolves(storedLink());
      cognito.on(AdminGetUserCommand).resolves({ UserStatus: "CONFIRMED" });
      cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s" });
      cognito.on(RespondToAuthChallengeCommand).resolves({ AuthenticationResult: COGNITO_TOKENS });
    },
    success: [
      200,
      { idToken: "id", accessToken: "access", refreshToken: "refresh", expiresIn: 900, tokenType: "Bearer" },
    ],
    env: ["MAGIC_LINKS_TABLE", "USER_POOL_ID", "USER_POOL_CLIENT_ID"],
    failWith: (error) => dynamo.on(GetCommand).rejects(error),
  },
  "POST /auth/refresh": {
    handler: refreshHandler,
    valid: { refreshToken: "refresh" },
    succeed: () =>
      cognito
        .on(InitiateAuthCommand)
        .resolves({ AuthenticationResult: { ...COGNITO_TOKENS, RefreshToken: undefined } }),
    success: [200, { idToken: "id", accessToken: "access", expiresIn: 900, tokenType: "Bearer" }],
    env: ["USER_POOL_ID", "USER_POOL_CLIENT_ID"],
    failWith: (error) => cognito.on(InitiateAuthCommand).rejects(error),
  },
  "POST /logout": {
    handler: logoutHandler,
    valid: { refreshToken: "refresh" },
    succeed: () => cognito.on(RevokeTokenCommand).resolves({}),
    success: [204],
    env: ["USER_POOL_ID", "USER_POOL_CLIENT_ID"],
    failWith: (error) => cognito.on(RevokeTokenCommand).rejects(error),
  },
};

const JSON_ROUTES = Object.entries(ROUTES);

const UNSUPPORTED_MEDIA = { message: "Content-Type must be application/json" };
const BODY_REQUIRED = { message: "Request body is required" };
const NOT_JSON = { message: "Request body must be valid JSON" };
const notAnObject = (received: string) => invalid(["", `Invalid input: expected object, received ${received}`]);

/** The error names AWS services use for throttling: all mapped to 429. */
const THROTTLING_ERRORS = [
  "TooManyRequestsException",
  "ThrottlingException",
  "Throttling",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "RequestThrottled",
];

const awsError = (name: string, message = "internal detail: arn:aws:secret") =>
  Object.assign(new Error(message), { name });

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

describe.each(JSON_ROUTES)("%s: input and output contract", (_route, route) => {
  const noAwsCall = () => {
    expect(cognito.calls()).toHaveLength(0);
    expect(dynamo.calls()).toHaveLength(0);
    expect(sqs.calls()).toHaveLength(0);
  };

  describe("happy path", () => {
    it("answers the documented success response", async () => {
      route.succeed();
      expectResponse(await send(route.handler, route.valid), ...route.success);
    });

    it.each([["application/json; charset=utf-8"], ["APPLICATION/JSON"], [" application/json ;charset=UTF-8"]])(
      "accepts Content-Type %j",
      async (contentType) => {
        route.succeed();
        const response = await invoke(
          route.handler,
          event(JSON.stringify(route.valid), { "content-type": contentType }),
        );
        expectResponse(response, ...route.success);
      },
    );

    it("accepts a base64-encoded body (API Gateway binary passthrough)", async () => {
      route.succeed();
      const body = Buffer.from(JSON.stringify(route.valid)).toString("base64");
      const response = await invoke(route.handler, { ...event(body), isBase64Encoded: true });
      expectResponse(response, ...route.success);
    });

    it("ignores unknown fields", async () => {
      route.succeed();
      expectResponse(await send(route.handler, { ...route.valid, admin: true, role: "root" }), ...route.success);
    });
  });

  describe("415: body not declared as JSON", () => {
    it.each([
      ["no Content-Type", {}],
      ["no headers at all", null],
      ["text/plain", { "Content-Type": "text/plain" }],
      ["a form", { "Content-Type": "application/x-www-form-urlencoded" }],
      ["multipart", { "Content-Type": "multipart/form-data; boundary=x" }],
      ["a JSON look-alike", { "Content-Type": "application/jsonp" }],
      ["an empty Content-Type", { "Content-Type": "" }],
    ])("%s", async (_label, headers) => {
      expectResponse(await invoke(route.handler, event(JSON.stringify(route.valid), headers)), 415, UNSUPPORTED_MEDIA);
      noAwsCall();
    });
  });

  describe("400: malformed body", () => {
    it.each([
      ["no body", null, BODY_REQUIRED],
      ["an empty body", "", BODY_REQUIRED],
      ["invalid JSON", "{nope", NOT_JSON],
      ["truncated JSON", JSON.stringify(route.valid).slice(0, -1), NOT_JSON],
      ["JSON null", "null", notAnObject("null")],
      ["a JSON array", "[]", notAnObject("array")],
      ["a JSON string", '"hello"', notAnObject("string")],
      ["a JSON number", "42", notAnObject("number")],
      ["a JSON boolean", "true", notAnObject("boolean")],
    ])("%s", async (_label, body, expected) => {
      expectResponse(await invoke(route.handler, event(body)), 400, expected);
      noAwsCall();
    });

    it("invalid JSON inside a base64-encoded body", async () => {
      const response = await invoke(route.handler, {
        ...event(Buffer.from("{nope").toString("base64")),
        isBase64Encoded: true,
      });
      expectResponse(response, 400, NOT_JSON);
    });
  });

  describe("429 / 500: dependency failures", () => {
    it.each(THROTTLING_ERRORS)("429 with Retry-After when AWS keeps throwing %s", async (name) => {
      route.failWith(awsError(name));
      expectResponse(await send(route.handler, route.valid), 429, {
        message: "Too many requests, please try again shortly",
      });
    });

    it("500 without leaking internals on any other AWS error", async () => {
      route.failWith(awsError("InternalErrorException"));
      const response = await send(route.handler, route.valid);
      expectResponse(response, 500, { message: "Internal server error" });
      expect(response.body).not.toContain("arn:aws");
    });

    it("500 when something that is not an Error is thrown", async () => {
      route.failWith("a string, not an Error" as unknown as Error);
      expectResponse(await send(route.handler, route.valid), 500, { message: "Internal server error" });
    });

    it.each(route.env)("500 without naming the variable when %s is not configured", async (name) => {
      route.succeed();
      delete process.env[name];
      const response = await send(route.handler, route.valid);
      expectResponse(response, 500, { message: "Internal server error" });
      expect(response.body).not.toContain(name);
    });
  });
});

describe("POST /login: fields", () => {
  const login = (body: unknown) => send(loginHandler, body);
  const at254 = `${"a".repeat(254 - "@example.com".length)}@example.com`;

  beforeEach(() => {
    sqs.on(SendMessageCommand).resolves({});
  });

  it.each([
    ["a 254-character email (the RFC 5321 limit)", at254, at254],
    ["upper case and surrounding spaces, normalised", "  Luiz@Example.COM\t", EMAIL],
    ["a plus address", "luiz+tag@example.com", "luiz+tag@example.com"],
    ["a subdomain", "luiz@mail.example.co.uk", "luiz@mail.example.co.uk"],
  ])("202 for %s, queued normalised", async (_label, email, queued) => {
    expectResponse(await login({ email }), 202, GENERIC_RESPONSE);
    expect(JSON.parse(sqs.commandCalls(SendMessageCommand)[0]!.args[0].input.MessageBody ?? "").email).toBe(queued);
  });

  it.each([
    ["missing", {}, "email is required"],
    ["null", { email: null }, "email is required"],
    ["a number", { email: 42 }, "email is required"],
    ["an object", { email: { $ne: "" } }, "email is required"],
    ["an array", { email: [EMAIL] }, "email is required"],
    ["empty", { email: "" }, "email must be a valid email address"],
    ["only spaces", { email: "   " }, "email must be a valid email address"],
    ["without @", { email: "luiz.example.com" }, "email must be a valid email address"],
    ["without a domain", { email: "luiz@" }, "email must be a valid email address"],
    ["without a TLD", { email: "luiz@localhost" }, "email must be a valid email address"],
    ["with two @", { email: "luiz@@example.com" }, "email must be a valid email address"],
    ["with a space inside", { email: "lu iz@example.com" }, "email must be a valid email address"],
    [
      "with a header injection",
      { email: `${EMAIL}\r\nBcc: victim@example.com` },
      "email must be a valid email address",
    ],
    ["255 characters long", { email: `a${at254}` }, "email is too long"],
  ])("400 when email is %s", async (_label, body, message) => {
    expectResponse(await login(body), 400, invalid(["email", message]));
    expect(sqs.calls()).toHaveLength(0);
  });
});

describe("POST /auth/verify: fields", () => {
  const verify = (body: unknown) => send(verifyHandler, body);

  it("200 with the email in another case and with spaces", async () => {
    ROUTES["POST /auth/verify"]!.succeed();
    expectResponse(await verify({ email: `  ${EMAIL.toUpperCase()} `, token: TOKEN }), 200, expect.any(Object));
    expect(dynamo.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ pk: `EMAIL#${EMAIL}` });
  });

  it("200 defaults expiresIn and tokenType when Cognito omits them", async () => {
    ROUTES["POST /auth/verify"]!.succeed();
    cognito.on(RespondToAuthChallengeCommand).resolves({ AuthenticationResult: { IdToken: "id", AccessToken: "a" } });
    expectResponse(await verify({ email: EMAIL, token: TOKEN }), 200, {
      idToken: "id",
      accessToken: "a",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
  });

  it.each([
    [
      "{}",
      {},
      [
        ["email", "email is required"],
        ["token", "token is required"],
      ],
    ],
    ["no token", { email: EMAIL }, [["token", "token is required"]]],
    ["no email", { token: TOKEN }, [["email", "email is required"]]],
    ["an invalid email", { email: "nope", token: TOKEN }, [["email", "email must be a valid email address"]]],
    ["a token that is a number", { email: EMAIL, token: 1 }, [["token", "token is required"]]],
    ["a null token", { email: EMAIL, token: null }, [["token", "token is required"]]],
    ["an empty token", { email: EMAIL, token: "" }, [["token", "token has an invalid format"]]],
    ["a 63-character token", { email: EMAIL, token: TOKEN.slice(1) }, [["token", "token has an invalid format"]]],
    ["a 65-character token", { email: EMAIL, token: `${TOKEN}a` }, [["token", "token has an invalid format"]]],
    ["an upper-case token", { email: EMAIL, token: TOKEN.toUpperCase() }, [["token", "token has an invalid format"]]],
    ["a non-hex token", { email: EMAIL, token: "g".repeat(64) }, [["token", "token has an invalid format"]]],
    ["a token with spaces", { email: EMAIL, token: ` ${TOKEN.slice(2)} ` }, [["token", "token has an invalid format"]]],
    ["a token with a newline", { email: EMAIL, token: `${TOKEN}\n` }, [["token", "token has an invalid format"]]],
    [
      "both invalid",
      { email: "nope", token: "short" },
      [
        ["email", "email must be a valid email address"],
        ["token", "token has an invalid format"],
      ],
    ],
  ] as [string, unknown, [string, string][]][])(
    "400 for %s, without touching the table or Cognito",
    async (_l, body, errors) => {
      expectResponse(await verify(body), 400, invalid(...errors));
      expect(dynamo.calls()).toHaveLength(0);
      expect(cognito.calls()).toHaveLength(0);
    },
  );

  it.each([
    [
      "Cognito rejects the answer",
      () =>
        cognito.on(RespondToAuthChallengeCommand).rejects(new NotAuthorizedException({ message: "x", $metadata: {} })),
    ],
    ["Cognito returns no tokens", () => cognito.on(RespondToAuthChallengeCommand).resolves({})],
    [
      "Cognito asks for another challenge",
      () => cognito.on(InitiateAuthCommand).resolves({ ChallengeName: "SMS_MFA", Session: "s" }),
    ],
  ])("401 when %s, with a generic message", async (_label, arrange) => {
    ROUTES["POST /auth/verify"]!.succeed();
    arrange();
    const response = await verify({ email: EMAIL, token: TOKEN });
    expect(response.statusCode).toBe(401);
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(JSON.parse(response.body)).toHaveProperty("message");
    expect(response.body).not.toContain("SMS_MFA");
  });

  it("429 when DynamoDB throttles the link check", async () => {
    dynamo.on(GetCommand).rejects(new ProvisionedThroughputExceededException({ message: "slow", $metadata: {} }));
    expectResponse(await verify({ email: EMAIL, token: TOKEN }), 429, {
      message: "Too many requests, please try again shortly",
    });
  });

  it("429 when Cognito throttles the user lookup", async () => {
    dynamo.on(GetCommand).resolves(storedLink());
    cognito.on(AdminGetUserCommand).rejects(new TooManyRequestsException({ message: "slow", $metadata: {} }));
    expectResponse(await verify({ email: EMAIL, token: TOKEN }), 429, {
      message: "Too many requests, please try again shortly",
    });
  });
});

describe.each([
  ["POST /auth/refresh", refreshHandler],
  ["POST /logout", logoutHandler],
] as const)("%s: refreshToken field", (route, handler) => {
  it("accepts a token of exactly 8192 characters", async () => {
    ROUTES[route]!.succeed();
    expectResponse(await send(handler, { refreshToken: "x".repeat(8192) }), ...ROUTES[route]!.success);
  });

  it.each([
    ["missing", {}, "refreshToken is required"],
    ["null", { refreshToken: null }, "refreshToken is required"],
    ["empty", { refreshToken: "" }, "refreshToken is required"],
    ["a number", { refreshToken: 42 }, "refreshToken is required"],
    ["an object", { refreshToken: { token: "x" } }, "refreshToken is required"],
    ["an array", { refreshToken: ["x"] }, "refreshToken is required"],
    ["8193 characters long", { refreshToken: "x".repeat(8193) }, "refreshToken is too long"],
  ])("400 when refreshToken is %s, without calling Cognito", async (_label, body, message) => {
    expectResponse(await send(handler, body), 400, invalid(["refreshToken", message]));
    expect(cognito.calls()).toHaveLength(0);
  });
});

describe("POST /auth/refresh: outcomes", () => {
  it.each([
    ["revoked", new NotAuthorizedException({ message: "Refresh Token has been revoked", $metadata: {} })],
    ["expired", new NotAuthorizedException({ message: "Refresh Token has expired", $metadata: {} })],
  ])("401 when the refresh token is %s", async (_label, error) => {
    cognito.on(InitiateAuthCommand).rejects(error);
    expectResponse(await send(refreshHandler, { refreshToken: "r" }), 401, { message: "Session expired or revoked" });
  });

  it("401 when Cognito answers without tokens", async () => {
    cognito.on(InitiateAuthCommand).resolves({});
    expectResponse(await send(refreshHandler, { refreshToken: "r" }), 401, { message: "Session expired or revoked" });
  });

  it("forwards the refresh token to Cognito untouched", async () => {
    ROUTES["POST /auth/refresh"]!.succeed();
    await send(refreshHandler, { refreshToken: "  spaced  " });
    expect(cognito.commandCalls(InitiateAuthCommand)[0]!.args[0].input).toMatchObject({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: "client-id",
      AuthParameters: { REFRESH_TOKEN: "  spaced  " },
    });
  });
});

describe("POST /logout: outcomes", () => {
  it("204 for a token of another type (an ID or access token)", async () => {
    cognito.on(RevokeTokenCommand).rejects(new UnsupportedTokenTypeException({ message: "x", $metadata: {} }));
    expectResponse(await send(logoutHandler, { refreshToken: "an.access.token" }), 204);
  });
});

describe("GET /me: input and output contract", () => {
  // Signature checks are in handlers.test.ts.
  const callMe = (headers: Record<string, string> | null) =>
    invoke(meHandler, { headers } as unknown as APIGatewayProxyEvent);

  beforeEach(() => {
    process.env.ID_TOKEN_ISSUER = "http://127.0.0.1:9/us-east-1_pool";
  });

  it.each([
    ["no headers", null],
    ["no Authorization header", {}],
    ["an empty Authorization header", { Authorization: "" }],
    ["only the word Bearer", { Authorization: "Bearer" }],
    ["a Basic credential", { Authorization: "Basic dXNlcjpwYXNz" }],
    ["a lower-case header name with garbage", { authorization: "garbage" }],
    ["a JWT with two parts", { Authorization: "a.b" }],
    ["a JWT with four parts", { Authorization: "a.b.c.d" }],
  ])("401 Unauthorized for %s", async (_label, headers) => {
    expectResponse(await callMe(headers), 401, { message: "Unauthorized" });
  });
});

describe("send-magic-link worker: input and output contract", () => {
  const run = async (...bodies: string[]) =>
    (await sendMagicLinkHandler(
      { Records: bodies.map((body, i) => ({ messageId: `m${i}`, body })) } as unknown as SQSEvent,
      {} as Context,
      () => undefined,
    )) as SQSBatchResponse;

  beforeEach(() => {
    dynamo.on(GetCommand).resolves({});
    dynamo.on(PutCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "1" });
  });

  it("an empty batch reports no failures", async () => {
    expect(await run()).toEqual({ batchItemFailures: [] });
  });

  it("accepts the message POST /login queues, and one queued before requestedAt existed", async () => {
    expect(await run(JSON.stringify({ email: EMAIL, requestedAt: NOW_S }), JSON.stringify({ email: EMAIL }))).toEqual({
      batchItemFailures: [],
    });
    expect(dynamo.commandCalls(PutCommand).length).toBeGreaterThan(0);
  });

  it.each([
    ["an empty body", ""],
    ["JSON null", "null"],
    ["an array", "[]"],
    ["a requestedAt that is a string", JSON.stringify({ email: EMAIL, requestedAt: "1700000000" })],
    ["a negative requestedAt", JSON.stringify({ email: EMAIL, requestedAt: -1 })],
    ["a zero requestedAt", JSON.stringify({ email: EMAIL, requestedAt: 0 })],
    ["a fractional requestedAt", JSON.stringify({ email: EMAIL, requestedAt: 1.5 })],
    ["an email that is too long", JSON.stringify({ email: `${"a".repeat(250)}@example.com` })],
  ])("drops %s without retrying or touching AWS", async (_label, body) => {
    expect(await run(body)).toEqual({ batchItemFailures: [] });
    expect(dynamo.calls()).toHaveLength(0);
    expect(ses.calls()).toHaveLength(0);
  });

  it("retries a message whose DynamoDB read fails", async () => {
    dynamo.on(GetCommand).rejects(new Error("DynamoDB is down"));
    expect(await run(JSON.stringify({ email: EMAIL }))).toEqual({ batchItemFailures: [{ itemIdentifier: "m0" }] });
  });

  it.each(["MAGIC_LINKS_TABLE", "SES_FROM_ADDRESS", "MAGIC_LINK_CALLBACK_URL"])(
    "fails the whole batch (SQS retries it) when %s is not configured",
    async (name) => {
      delete process.env[name];
      await expect(run(JSON.stringify({ email: EMAIL }))).rejects.toThrow(name);
    },
  );

  it("fails the whole batch when a numeric setting is invalid", async () => {
    process.env.MAGIC_LINK_TTL_SECONDS = "-5";
    await expect(run(JSON.stringify({ email: EMAIL }))).rejects.toThrow("MAGIC_LINK_TTL_SECONDS");
  });
});
