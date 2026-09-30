/**
 * Smoke tests for the protections LocalStack provisions but does not enforce.
 * They only run against a stack deployed to a real AWS account:
 *
 *   make aws-infra     # Terraform workspace "aws", target = "aws"
 *   make test-aws      # this file
 *   make aws-destroy
 *
 * No real mailbox is needed: links are written straight to the table, and the
 * WAF test mails SES's mailbox simulator. The WAF test blocks POST /login from
 * this machine's IP for the WAF window (5 minutes by default).
 */

import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  UpdateUserAttributesCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, describe, expect, it } from "vitest";

function awsStack() {
  try {
    const outputs = JSON.parse(
      execSync("terraform -chdir=infrastructure/terraform output -json", {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString(),
    ) as Record<string, { value: string }>;
    if (outputs.target?.value !== "aws") return undefined;
    return {
      apiUrl: outputs.api_url!.value.replace(/\/$/, ""),
      tableName: outputs.magic_links_table!.value,
      userPoolId: outputs.user_pool_id!.value,
      clientId: outputs.user_pool_client_id!.value,
    };
  } catch {
    return undefined;
  }
}

const stack = process.env.AWS_SMOKE === "1" ? awsStack() : undefined;
if (!stack) console.warn("⚠ Skipping AWS smoke tests: run `make aws-infra` then `make test-aws`.");

const cognito = new CognitoIdentityProviderClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const created: string[] = [];
const unique = (label: string) => `smoke-${label}-${Date.now()}-${randomBytes(3).toString("hex")}@example.com`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const post = (path: string, body: unknown) =>
  fetch(`${stack?.apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Signs in without a mailbox: stores a link whose token we know, then exchanges it like the frontend does. */
async function signIn(email: string) {
  const token = randomBytes(32).toString("hex");
  const now = Math.floor(Date.now() / 1000);
  await dynamo.send(
    new PutCommand({
      TableName: stack?.tableName,
      Item: {
        pk: `EMAIL#${email}`,
        email,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        createdAt: now,
        expiresAt: now + 600,
        used: false,
      },
    }),
  );
  created.push(email);
  const response = await post("/auth/verify", { email, token });
  expect(response.status).toBe(200);
  return (await response.json()) as { idToken: string; accessToken: string };
}

const startAuth = (email: string) =>
  cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: stack?.clientId,
      AuthParameters: { USERNAME: email },
    }),
  );

describe.runIf(stack)("real AWS smoke tests", { timeout: 180_000 }, () => {
  afterAll(async () => {
    for (const email of created) {
      await cognito
        .send(new AdminDeleteUserCommand({ UserPoolId: stack?.userPoolId, Username: email }))
        .catch(() => undefined);
      await dynamo
        .send(new DeleteCommand({ TableName: stack?.tableName, Key: { pk: `EMAIL#${email}` } }))
        .catch(() => undefined);
    }
  });

  it("a user cannot change their own email (write_attributes is enforced)", async () => {
    const { accessToken } = await signIn(unique("email-change"));

    const change = cognito.send(
      new UpdateUserAttributesCommand({
        AccessToken: accessToken,
        UserAttributes: [{ Name: "email", Value: unique("victim") }],
      }),
    );

    await expect(change).rejects.toThrow(/unauthorized attribute|not authorized/i);
  });

  it("calling Cognito directly does not reveal whether an account exists (decoy challenge)", async () => {
    const existing = unique("known");
    await signIn(existing);

    const known = await startAuth(existing);
    const unknown = await startAuth(unique("ghost"));

    expect(unknown.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(known.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(Object.keys(unknown.ChallengeParameters ?? {}).sort()).toEqual(
      Object.keys(known.ChallengeParameters ?? {}).sort(),
    );
    expect(unknown.ChallengeParameters).not.toHaveProperty("email");
  });

  it("an unknown user never gets tokens, whatever the answers", async () => {
    const email = unique("ghost-answers");
    let challenge = await startAuth(email);

    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = await cognito
        .send(
          new RespondToAuthChallengeCommand({
            ClientId: stack?.clientId,
            ChallengeName: "CUSTOM_CHALLENGE",
            Session: challenge.Session,
            ChallengeResponses: {
              USERNAME: challenge.ChallengeParameters?.USERNAME ?? email,
              ANSWER: randomBytes(32).toString("hex"),
            },
          }),
        )
        .catch(() => undefined);
      expect(answer?.AuthenticationResult).toBeUndefined();
      if (!answer?.Session) break;
      challenge = { ...challenge, Session: answer.Session };
    }
  });

  it("the Cognito authorizer rejects forged ID tokens", async () => {
    const { idToken } = await signIn(unique("jwt"));
    const [header, payload, signature] = idToken.split(".");
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: "someone-else" })).toString("base64url");
    const none = Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url");
    const me = (authorization: string) => fetch(`${stack?.apiUrl}/me`, { headers: { Authorization: authorization } });

    expect((await me(idToken)).status).toBe(200);
    expect((await me(`${header}.${forged}.${signature}`)).status).toBe(401);
    expect((await me(`${none}.${forged}.`)).status).toBeGreaterThanOrEqual(401);
  });

  // Last: it blocks POST /login from this IP for the WAF window.
  it("WAF rate-limits POST /login per IP, including /login/ and //login", async () => {
    let blocked = false;
    // Rate-based rules take a little while to aggregate: keep asking until the block shows up.
    for (let i = 0; i < 60 && !blocked; i++) {
      const response = await post("/login", { email: `success+smoke${i}@simulator.amazonses.com` });
      blocked = response.status === 429;
      if (!blocked) await sleep(1_500);
    }
    expect(blocked).toBe(true);

    for (const path of ["/login/", "//login"]) {
      const response = await post(path, { email: "success@simulator.amazonses.com" });
      expect(response.status, `${path} must be counted by the same rule`).toBe(429);
    }
  });
});
