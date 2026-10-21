import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/** One item per email: a new link replaces (and invalidates) the previous one. */
export interface MagicLinkRecord {
  pk: string;
  email: string;
  tokenHash: string;
  /** Epoch seconds. */
  createdAt: number;
  /** Epoch seconds. The link stops working after this. */
  expiresAt: number;
  used: boolean;
  /** Epoch seconds, set when the link is consumed. */
  usedAt?: number;
  /** Links issued in a row without one being used (drives the cooldown). Absent = 0. */
  streak?: number;
  /** SQS message that issued the link. */
  requestId?: string;
  /** Epoch seconds, set once SES accepted the email. */
  deliveredAt?: number;
  /** Epoch seconds: DynamoDB TTL. Outlives `expiresAt` to keep the streak. */
  purgeAt: number;
}

export type NewMagicLink = Omit<MagicLinkRecord, "pk" | "used" | "usedAt" | "deliveredAt">;

/** The item as read when deciding to issue. */
export interface ExpectedLink {
  tokenHash: string;
  used: boolean;
  /** The decision requires the link to be undelivered. */
  undelivered?: boolean;
}

export const emailKey = (email: string): string => `EMAIL#${email}`;

export class MagicLinkRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Stores a link only if the item is unchanged since it was read.
   * @returns false when it changed.
   */
  async save(link: NewMagicLink, expected: ExpectedLink | undefined): Promise<boolean> {
    const record: MagicLinkRecord = { pk: emailKey(link.email), ...link, used: false };
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ...(expected === undefined
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : {
                ConditionExpression: `tokenHash = :expectedHash AND #used = :expectedUsed${
                  expected.undelivered ? " AND attribute_not_exists(deliveredAt)" : ""
                }`,
                ExpressionAttributeNames: { "#used": "used" },
                ExpressionAttributeValues: { ":expectedHash": expected.tokenHash, ":expectedUsed": expected.used },
              }),
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  /** Records that the email was sent; a replaced link is left alone. */
  async markDelivered(email: string, tokenHash: string, nowEpochSeconds: number): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: emailKey(email) },
          UpdateExpression: "SET deliveredAt = :now",
          ConditionExpression: "tokenHash = :hash",
          ExpressionAttributeValues: { ":hash": tokenHash, ":now": nowEpochSeconds },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return;
      throw error;
    }
  }

  /** Deletes an undelivered link, only if it is still this one. */
  async deleteUndelivered(email: string, tokenHash: string): Promise<void> {
    try {
      await this.db.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: { pk: emailKey(email) },
          ConditionExpression: "tokenHash = :hash AND #used = :false",
          ExpressionAttributeNames: { "#used": "used" },
          ExpressionAttributeValues: { ":hash": tokenHash, ":false": false },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return;
      throw error;
    }
  }

  async findByEmail(email: string): Promise<MagicLinkRecord | undefined> {
    const { Item } = await this.db.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: emailKey(email) },
        ConsistentRead: true,
      }),
    );
    return Item as MagicLinkRecord | undefined;
  }

  /**
   * Atomically marks the link used, re-checking every invariant.
   * @returns false when it is used, expired or replaced.
   */
  async markAsUsed(email: string, tokenHash: string, nowEpochSeconds: number): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: emailKey(email) },
          UpdateExpression: "SET #used = :true, usedAt = :now",
          ConditionExpression: "attribute_exists(pk) AND #used = :false AND tokenHash = :hash AND expiresAt > :now",
          ExpressionAttributeNames: { "#used": "used" },
          ExpressionAttributeValues: {
            ":true": true,
            ":false": false,
            ":hash": tokenHash,
            ":now": nowEpochSeconds,
          },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }
}
