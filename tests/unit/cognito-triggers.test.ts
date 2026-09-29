import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  Context,
  CreateAuthChallengeTriggerEvent,
  DefineAuthChallengeTriggerEvent,
  VerifyAuthChallengeResponseTriggerEvent,
} from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { hashToken } from "../../apps/api/src/services/token.service.js";
import { handler as createAuthChallenge } from "../../apps/cognito/triggers/create-auth-challenge.js";
import { handler as defineAuthChallenge, MAX_ATTEMPTS } from "../../apps/cognito/triggers/define-auth-challenge.js";
import { handler as verifyAuthChallenge } from "../../apps/cognito/triggers/verify-auth-challenge.js";

const EMAIL = "luiz@example.com";
const TOKEN = "ab".repeat(32);
const context = {} as Context;
const callback = () => undefined;

type Session = DefineAuthChallengeTriggerEvent["request"]["session"];

function defineEvent(session: Session, userNotFound = false): DefineAuthChallengeTriggerEvent {
  return {
    request: { userAttributes: { email: EMAIL }, session, userNotFound },
    response: {},
  } as unknown as DefineAuthChallengeTriggerEvent;
}

const attempt = (challengeResult: boolean) => ({
  challengeName: "CUSTOM_CHALLENGE" as const,
  challengeResult,
  challengeMetadata: "MAGIC_LINK",
});

describe("DefineAuthChallenge", () => {
  it("starts with a custom challenge", async () => {
    const result = (await defineAuthChallenge(defineEvent([]), context, callback))!;
    expect(result.response).toEqual({
      issueTokens: false,
      failAuthentication: false,
      challengeName: "CUSTOM_CHALLENGE",
    });
  });

  it("issues tokens after a correct answer", async () => {
    const result = (await defineAuthChallenge(defineEvent([attempt(true)]), context, callback))!;
    expect(result.response).toMatchObject({ issueTokens: true, failAuthentication: false });
  });

  it("allows a retry after a wrong answer", async () => {
    const result = (await defineAuthChallenge(defineEvent([attempt(false)]), context, callback))!;
    expect(result.response.challengeName).toBe("CUSTOM_CHALLENGE");
  });

  it(`fails after ${MAX_ATTEMPTS} wrong answers`, async () => {
    const session = Array.from({ length: MAX_ATTEMPTS }, () => attempt(false));
    const result = (await defineAuthChallenge(defineEvent(session), context, callback))!;
    expect(result.response).toMatchObject({ issueTokens: false, failAuthentication: true });
  });

  it("fails when the user does not exist", async () => {
    const result = (await defineAuthChallenge(defineEvent([], true), context, callback))!;
    expect(result.response.failAuthentication).toBe(true);
  });

  it("refuses sessions that mix in other challenge types", async () => {
    const session = [{ challengeName: "PASSWORD_VERIFIER", challengeResult: true }] as unknown as Session;
    const result = (await defineAuthChallenge(defineEvent(session), context, callback))!;
    expect(result.response).toMatchObject({ issueTokens: false, failAuthentication: true });
  });
});

describe("CreateAuthChallenge", () => {
  it("exposes only the email publicly and keeps no secret in the challenge", async () => {
    const event = {
      request: { userAttributes: { email: EMAIL }, challengeName: "CUSTOM_CHALLENGE", session: [] },
      response: {},
    } as unknown as CreateAuthChallengeTriggerEvent;

    const result = (await createAuthChallenge(event, context, callback))!;
    expect(result.response).toEqual({
      publicChallengeParameters: { email: EMAIL },
      privateChallengeParameters: {},
      challengeMetadata: "MAGIC_LINK",
    });
  });

  it("falls back to an empty email when the user has none", async () => {
    const event = {
      request: { userAttributes: {}, challengeName: "CUSTOM_CHALLENGE", session: [] },
      response: {},
    } as unknown as CreateAuthChallengeTriggerEvent;

    const result = (await createAuthChallenge(event, context, callback))!;
    expect(result.response.publicChallengeParameters).toEqual({ email: "" });
  });
});

describe("VerifyAuthChallengeResponse", () => {
  const dynamo = mockClient(DynamoDBDocumentClient);
  const now = Math.floor(Date.now() / 1000);

  const verifyEvent = (answer: string, email: string | null = EMAIL) =>
    ({
      request: { userAttributes: email ? { email } : {}, challengeAnswer: answer, privateChallengeParameters: {} },
      response: {},
    }) as unknown as VerifyAuthChallengeResponseTriggerEvent;

  beforeEach(() => {
    dynamo.reset();
    process.env.MAGIC_LINKS_TABLE = "magic-links";
  });

  it("accepts a valid token and consumes it", async () => {
    dynamo.on(GetCommand).resolves({
      Item: {
        pk: `EMAIL#${EMAIL}`,
        email: EMAIL,
        tokenHash: hashToken(TOKEN),
        createdAt: now,
        expiresAt: now + 600,
        used: false,
      },
    });
    dynamo.on(UpdateCommand).resolves({});

    const result = (await verifyAuthChallenge(verifyEvent(TOKEN), context, callback))!;

    expect(result.response.answerCorrect).toBe(true);
    const update = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update.Key).toEqual({ pk: `EMAIL#${EMAIL}` });
    expect(update.ExpressionAttributeValues?.[":hash"]).toBe(hashToken(TOKEN));
  });

  it("rejects when the atomic consume loses a race", async () => {
    dynamo.on(GetCommand).resolves({
      Item: {
        pk: `EMAIL#${EMAIL}`,
        email: EMAIL,
        tokenHash: hashToken(TOKEN),
        createdAt: now,
        expiresAt: now + 600,
        used: false,
      },
    });
    dynamo.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "failed", $metadata: {} }));

    const result = (await verifyAuthChallenge(verifyEvent(TOKEN), context, callback))!;
    expect(result.response.answerCorrect).toBe(false);
  });

  it("rejects an unknown token", async () => {
    dynamo.on(GetCommand).resolves({});
    const result = (await verifyAuthChallenge(verifyEvent(TOKEN), context, callback))!;
    expect(result.response.answerCorrect).toBe(false);
    expect(dynamo.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("uses the email from Cognito, normalised, to look up the link", async () => {
    dynamo.on(GetCommand).resolves({});
    await verifyAuthChallenge(verifyEvent(TOKEN, "Luiz@Example.com"), context, callback);
    expect(dynamo.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ pk: `EMAIL#${EMAIL}` });
  });

  it("rejects when the Cognito user has no email", async () => {
    const result = (await verifyAuthChallenge(verifyEvent(TOKEN, null), context, callback))!;
    expect(result.response.answerCorrect).toBe(false);
    expect(dynamo.commandCalls(GetCommand)).toHaveLength(0);
  });
});
