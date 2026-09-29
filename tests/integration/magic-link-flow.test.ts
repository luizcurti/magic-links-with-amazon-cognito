/**
 * End-to-end tests against the real stack running on LocalStack:
 * API Gateway -> Lambda -> DynamoDB / SES / Cognito custom auth triggers.
 *
 * Prerequisites: make up && make infra
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../../apps/api/src/services/token.service.js";
import { isLocalStackUp, loadStack, LOCALSTACK_ENDPOINT, post, uniqueEmail, waitForMagicLink } from "./stack.js";

const stack = loadStack();
const ready = stack !== undefined && (await isLocalStackUp());

if (!ready) {
  console.warn("⚠ Skipping integration tests: run `make up && make infra` first.");
}

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: LOCALSTACK_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  }),
);

/** Requests a link and returns the token + email extracted from the captured email. */
async function requestLink(email: string) {
  const sentAfter = new Date(Date.now() - 1_000);
  const response = await post(`${stack!.apiUrl}/login`, { email });
  expect(response.status).toBe(202);

  const link = await waitForMagicLink(email, sentAfter);
  return { token: link.searchParams.get("token")!, email: link.searchParams.get("email")!, link };
}

describe.runIf(ready)("magic link flow (LocalStack)", { timeout: 60_000 }, () => {
  let apiUrl: string;

  beforeAll(() => {
    apiUrl = stack!.apiUrl;
  });

  it("successful authentication: login -> email -> JWT -> /me", async () => {
    const email = uniqueEmail("success");
    const { token, link } = await requestLink(email);

    expect(link.origin + link.pathname).toBe("http://localhost:5173/auth/callback");

    const verify = await post(`${apiUrl}/auth/verify`, { email, token });
    expect(verify.status).toBe(200);
    expect(verify.body.idToken.split(".")).toHaveLength(3);
    expect(verify.body.accessToken).toBeTruthy();

    const me = await fetch(`${apiUrl}/me`, { headers: { Authorization: verify.body.idToken } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email });
  });

  it("stores only the SHA-256 hash of the token", async () => {
    const email = uniqueEmail("hash");
    const { token } = await requestLink(email);

    const { Item } = await dynamo.send(
      new GetCommand({ TableName: stack!.tableName, Key: { pk: `EMAIL#${email}` } }),
    );

    expect(Item).toMatchObject({ email, tokenHash: hashToken(token), used: false });
    expect(JSON.stringify(Item)).not.toContain(token);
  });

  it("token reuse prevention: a link works only once", async () => {
    const email = uniqueEmail("reuse");
    const { token } = await requestLink(email);

    expect((await post(`${apiUrl}/auth/verify`, { email, token })).status).toBe(200);
    expect((await post(`${apiUrl}/auth/verify`, { email, token })).status).toBe(401);
  });

  it("invalid token is rejected", async () => {
    const email = uniqueEmail("invalid");
    await requestLink(email);

    const response = await post(`${apiUrl}/auth/verify`, { email, token: "0".repeat(64) });
    expect(response.status).toBe(401);
  });

  it("wrong email: a token cannot authenticate another account", async () => {
    const victim = uniqueEmail("victim");
    const attacker = uniqueEmail("attacker");
    const { token } = await requestLink(victim);
    await requestLink(attacker);

    const response = await post(`${apiUrl}/auth/verify`, { email: attacker, token });
    expect(response.status).toBe(401);

    // The victim's link is still valid: the failed attempt did not burn it.
    expect((await post(`${apiUrl}/auth/verify`, { email: victim, token })).status).toBe(200);
  });

  it("token expiration: an expired link is rejected", async () => {
    const email = uniqueEmail("expired");
    const { token } = await requestLink(email);

    // Fast-forward time by moving expiresAt into the past.
    await dynamo.send(
      new UpdateCommand({
        TableName: stack!.tableName,
        Key: { pk: `EMAIL#${email}` },
        UpdateExpression: "SET expiresAt = :past",
        ExpressionAttributeValues: { ":past": Math.floor(Date.now() / 1000) - 1 },
      }),
    );

    expect((await post(`${apiUrl}/auth/verify`, { email, token })).status).toBe(401);
  });

  it("token invalidation: requesting a new link invalidates the previous one", async () => {
    const email = uniqueEmail("rotate");
    const first = await requestLink(email);
    const second = await requestLink(email);

    expect((await post(`${apiUrl}/auth/verify`, { email, token: first.token })).status).toBe(401);
    expect((await post(`${apiUrl}/auth/verify`, { email, token: second.token })).status).toBe(200);
  });

  it("returns the same response for new and existing users (no enumeration)", async () => {
    const email = uniqueEmail("enum");
    const first = await post(`${apiUrl}/login`, { email });
    const second = await post(`${apiUrl}/login`, { email });

    expect(first).toEqual(second);
  });

  it("rejects invalid input with 400", async () => {
    expect((await post(`${apiUrl}/login`, { email: "nope" })).status).toBe(400);
    expect((await post(`${apiUrl}/auth/verify`, { email: "a@b.com", token: "short" })).status).toBe(400);
  });

  it("protects /me with the Cognito authorizer", async () => {
    const response = await fetch(`${apiUrl}/me`);
    expect(response.status).toBe(401);
  });
});
