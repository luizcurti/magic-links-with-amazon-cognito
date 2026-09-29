import { mockClient } from "aws-sdk-client-mock";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { emailKey, MagicLinkRepository } from "../../apps/api/src/repositories/magic-link.repository.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const repository = new MagicLinkRepository(dynamo as unknown as DynamoDBDocumentClient, "magic-links");

describe("MagicLinkRepository", () => {
  beforeEach(() => dynamo.reset());

  it("uses EMAIL#<email> as partition key", () => {
    expect(emailKey("luiz@example.com")).toBe("EMAIL#luiz@example.com");
  });

  it("saves a new unused link, overwriting any previous one", async () => {
    dynamo.on(PutCommand).resolves({});
    await repository.save({ email: "luiz@example.com", tokenHash: "h", createdAt: 1, expiresAt: 601 });

    const input = dynamo.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input).toEqual({
      TableName: "magic-links",
      Item: { pk: "EMAIL#luiz@example.com", email: "luiz@example.com", tokenHash: "h", createdAt: 1, expiresAt: 601, used: false },
    });
    expect(input.ConditionExpression).toBeUndefined();
  });

  it("reads with strong consistency", async () => {
    dynamo.on(GetCommand).resolves({});
    await expect(repository.findByEmail("luiz@example.com")).resolves.toBeUndefined();
    expect(dynamo.commandCalls(GetCommand)[0]!.args[0].input.ConsistentRead).toBe(true);
  });

  it("marks a link as used with a conditional update", async () => {
    dynamo.on(UpdateCommand).resolves({});
    await expect(repository.markAsUsed("luiz@example.com", "h", 100)).resolves.toBe(true);

    const input = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe(
      "attribute_exists(pk) AND #used = :false AND tokenHash = :hash AND expiresAt > :now",
    );
    expect(input.ExpressionAttributeValues).toEqual({ ":true": true, ":false": false, ":hash": "h", ":now": 100 });
  });

  it("returns false when the condition fails", async () => {
    dynamo.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "failed", $metadata: {} }));
    await expect(repository.markAsUsed("luiz@example.com", "h", 100)).resolves.toBe(false);
  });

  it("propagates unexpected errors", async () => {
    dynamo.on(UpdateCommand).rejects(new Error("boom"));
    await expect(repository.markAsUsed("luiz@example.com", "h", 100)).rejects.toThrow("boom");
  });
});
