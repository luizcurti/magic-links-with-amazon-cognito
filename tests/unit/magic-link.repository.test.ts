import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { emailKey, MagicLinkRepository } from "../../apps/api/src/repositories/magic-link.repository.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const repository = new MagicLinkRepository(dynamo as unknown as DynamoDBDocumentClient, "magic-links");

describe("MagicLinkRepository", () => {
  beforeEach(() => dynamo.reset());

  it("uses EMAIL#<email> as partition key", () => {
    expect(emailKey("luiz@example.com")).toBe("EMAIL#luiz@example.com");
  });

  const link = {
    email: "luiz@example.com",
    tokenHash: "h",
    createdAt: 100,
    expiresAt: 700,
    streak: 2,
    requestId: "msg-1",
    purgeAt: 86_500,
  };

  it("saves the first link only if there is still no item", async () => {
    dynamo.on(PutCommand).resolves({});
    await expect(repository.save(link, undefined)).resolves.toBe(true);

    expect(dynamo.commandCalls(PutCommand)[0]!.args[0].input).toEqual({
      TableName: "magic-links",
      Item: { pk: "EMAIL#luiz@example.com", ...link, used: false },
      ConditionExpression: "attribute_not_exists(pk)",
    });
  });

  it("replaces a link only if it is still the one the decision was based on", async () => {
    dynamo.on(PutCommand).resolves({});
    await repository.save(link, { tokenHash: "old", used: false });

    const input = dynamo.commandCalls(PutCommand)[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("tokenHash = :expectedHash AND #used = :expectedUsed");
    expect(input.ExpressionAttributeValues).toEqual({ ":expectedHash": "old", ":expectedUsed": false });
  });

  it("replaces its own undelivered link only while it is still undelivered", async () => {
    dynamo.on(PutCommand).resolves({});
    await repository.save(link, { tokenHash: "old", used: false, undelivered: true });

    expect(dynamo.commandCalls(PutCommand)[0]!.args[0].input.ConditionExpression).toBe(
      "tokenHash = :expectedHash AND #used = :expectedUsed AND attribute_not_exists(deliveredAt)",
    );
  });

  it("reports that the item changed since it was read", async () => {
    dynamo.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: "failed", $metadata: {} }));
    await expect(repository.save(link, undefined)).resolves.toBe(false);
  });

  it("propagates unexpected errors when saving", async () => {
    dynamo.on(PutCommand).rejects(new Error("boom"));
    await expect(repository.save(link, undefined)).rejects.toThrow("boom");
  });

  it("marks a link delivered, unless it was replaced meanwhile", async () => {
    dynamo.on(UpdateCommand).resolves({});
    await repository.markDelivered("luiz@example.com", "h", 100);

    const input = dynamo.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toBe("SET deliveredAt = :now");
    expect(input.ConditionExpression).toBe("tokenHash = :hash");

    dynamo.reset();
    dynamo.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: "failed", $metadata: {} }));
    await expect(repository.markDelivered("luiz@example.com", "h", 100)).resolves.toBeUndefined();

    dynamo.reset();
    dynamo.on(UpdateCommand).rejects(new Error("boom"));
    await expect(repository.markDelivered("luiz@example.com", "h", 100)).rejects.toThrow("boom");
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

  it("deletes an undelivered link only if it is still that same unused link", async () => {
    dynamo.on(DeleteCommand).resolves({});
    await repository.deleteUndelivered("luiz@example.com", "h");

    const input = dynamo.commandCalls(DeleteCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ pk: "EMAIL#luiz@example.com" });
    expect(input.ConditionExpression).toBe("tokenHash = :hash AND #used = :false");
    expect(input.ExpressionAttributeValues).toEqual({ ":hash": "h", ":false": false });
  });

  it("propagates unexpected errors when deleting an undelivered link", async () => {
    dynamo.on(DeleteCommand).rejects(new Error("boom"));
    await expect(repository.deleteUndelivered("luiz@example.com", "h")).rejects.toThrow("boom");
  });

  it("leaves a newer link alone when deleting an undelivered one", async () => {
    dynamo.on(DeleteCommand).rejects(new ConditionalCheckFailedException({ message: "failed", $metadata: {} }));
    await expect(repository.deleteUndelivered("luiz@example.com", "h")).resolves.toBeUndefined();
  });
});
