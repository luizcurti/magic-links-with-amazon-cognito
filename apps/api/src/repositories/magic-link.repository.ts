import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * One item per email address. Issuing a new link overwrites the previous item,
 * which invalidates any older link for that user.
 */
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
  /** Links issued in a row without one being used; drives the growing cooldown. Absent on older items (= 0). */
  streak?: number;
  /** The queued request (SQS message ID) that issued this link, so a retry of that request may replace it. */
  requestId?: string;
  /** Epoch seconds, set once the email was handed to SES. */
  deliveredAt?: number;
  /**
   * Epoch seconds: the DynamoDB TTL attribute. It outlives `expiresAt` so the
   * streak survives the link it belongs to; TTL deletion is lazy anyway, which
   * is why expiry is always checked against `expiresAt`.
   */
  purgeAt: number;
}

export type NewMagicLink = Omit<MagicLinkRecord, "pk" | "used" | "usedAt" | "deliveredAt">;

/** What the item looked like when the issuing decision was made. */
export interface ExpectedLink {
  tokenHash: string;
  used: boolean;
  /** The decision relied on the link not being delivered yet (a retry replacing its own link). */
  undelivered?: boolean;
}

export const emailKey = (email: string): string => `EMAIL#${email}`;

export class MagicLinkRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Stores a new link, replacing the previous one, only if the item is still
   * exactly what the caller read when it decided to issue (optimistic
   * concurrency): no item at all, or the same link in the same state. Two
   * parallel requests can therefore never both issue, and a link consumed or
   * replaced in the meantime is never overwritten on stale information.
   *
   * @returns false when the item changed since it was read.
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

  /**
   * Records that the email for this link was sent, so a retry of the same
   * request (the worker crashed after sending) does not send a second one.
   * A link replaced in the meantime is left alone.
   */
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

  /**
   * Removes a link that could not be delivered, so the cooldown does not keep
   * the user from getting another one. Only the link with this exact hash is
   * removed: a newer link stored in the meantime is left alone.
   */
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
   * Atomically flips `used` to true. The condition re-checks every invariant
   * on the server side, so two concurrent requests with the same token can
   * never both succeed, and a link replaced in the meantime cannot be used.
   *
   * @returns true if this call consumed the link, false if it was already
   *          used, expired, or superseded by a newer link.
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
