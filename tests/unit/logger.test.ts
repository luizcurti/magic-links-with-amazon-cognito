import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, Context, SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as loginHandler } from "../../apps/api/src/handlers/login.js";
import { handler as sendMagicLinkHandler } from "../../apps/api/src/handlers/send-magic-link.js";
import { logger, maskEmail, startInvocation, traceRoot } from "../../apps/api/src/lib/logger.js";

const TRACE = "Root=1-67891233-abcdef012345678912345678;Parent=53995c3f42cd8ad8;Sampled=1";

/** Every JSON line written to the console while `run` executes. */
async function captureLogs(run: () => unknown): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: string) => lines.push(line));
  }
  await run();
  return lines.map((line) => JSON.parse(line));
}

beforeEach(() => {
  vi.stubEnv("_X_AMZN_TRACE_ID", TRACE);
});

describe("logger", () => {
  it("writes one JSON line per entry, on the console method matching its level", async () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.info("a");
    logger.warn("b");
    logger.error("c", { error: "boom" });

    expect(JSON.parse(info.mock.calls[0]![0])).toMatchObject({ level: "info", message: "a" });
    expect(JSON.parse(warn.mock.calls[0]![0])).toMatchObject({ level: "warn", message: "b" });
    expect(JSON.parse(error.mock.calls[0]![0])).toMatchObject({ level: "error", message: "c", error: "boom" });
  });

  it("tags every entry with the invocation's request ID and X-Ray trace, until the next invocation", async () => {
    const logs = await captureLogs(() => {
      startInvocation({ awsRequestId: "req-1" }, { apiRequestId: "api-1" });
      logger.info("first");
      startInvocation({ awsRequestId: "req-2" });
      logger.info("second");
    });

    expect(logs[0]).toMatchObject({
      requestId: "req-1",
      apiRequestId: "api-1",
      traceId: "1-67891233-abcdef012345678912345678",
    });
    expect(logs[1]).toMatchObject({ requestId: "req-2" });
    expect(logs[1]).not.toHaveProperty("apiRequestId");
    expect(typeof logs[0]!.timestamp).toBe("string");
  });

  it.each([
    [TRACE, "1-67891233-abcdef012345678912345678"],
    ["Root=1-a-b", "1-a-b"],
    ["Parent=53995c3f42cd8ad8;Sampled=1", undefined],
    [undefined, undefined],
  ])("traceRoot(%j) = %j", (header, root) => {
    expect(traceRoot(header)).toBe(root);
  });

  it("masks emails down to their first letter and domain", () => {
    expect(maskEmail("luiz@example.com")).toBe("l***@example.com");
    expect(maskEmail("nope")).toBe("n***@");
  });
});

describe("request correlation in the handlers", () => {
  const sqs = mockClient(SQSClient);
  const dynamo = mockClient(DynamoDBDocumentClient);
  const ses = mockClient(SESClient);

  beforeEach(() => {
    sqs.reset();
    dynamo.reset();
    ses.reset();
    Object.assign(process.env, {
      LOGIN_QUEUE_URL: "http://sqs/q",
      MAGIC_LINKS_TABLE: "t",
      SES_FROM_ADDRESS: "no-reply@magic-links.local",
      MAGIC_LINK_CALLBACK_URL: "http://localhost:5173/auth/callback",
    });
  });

  it("POST /login logs the Lambda and API Gateway request IDs, never the plain email", async () => {
    sqs.on(SendMessageCommand).resolves({});
    const event = {
      body: JSON.stringify({ email: "luiz@example.com" }),
      headers: { "Content-Type": "application/json" },
      requestContext: { requestId: "api-req" },
    } as unknown as APIGatewayProxyEvent;

    const logs = await captureLogs(() =>
      loginHandler(event, { awsRequestId: "lambda-req" } as Context, () => undefined),
    );

    expect(logs).toContainEqual(
      expect.objectContaining({ message: "Magic link requested", requestId: "lambda-req", apiRequestId: "api-req" }),
    );
    expect(JSON.stringify(logs)).not.toContain("luiz@example.com");
  });

  it("the worker logs the trace of the POST /login that queued each message", async () => {
    dynamo.on(GetCommand).resolves({});
    dynamo.on(PutCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "1" });
    const event = {
      Records: [
        {
          messageId: "m1",
          body: JSON.stringify({ email: "a@example.com" }),
          attributes: { AWSTraceHeader: "Root=1-login-a;Sampled=1" },
        },
        { messageId: "m2", body: JSON.stringify({ email: "b@example.com" }), attributes: {} },
      ],
    } as unknown as SQSEvent;

    const logs = await captureLogs(() =>
      sendMagicLinkHandler(event, { awsRequestId: "worker-req" } as Context, () => undefined),
    );

    const sent = logs.filter((entry) => entry.message === "Magic link sent");
    expect(sent).toContainEqual(
      expect.objectContaining({ messageId: "m1", sourceTraceId: "1-login-a", requestId: "worker-req" }),
    );
    expect(sent.find((entry) => entry.messageId === "m2")).not.toHaveProperty("sourceTraceId");
  });
});
