import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { type DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * One item per email address. Requesting a new link overwrites the previous
 * item, which automatically invalidates any older link for that user.
 */
export interface MagicLinkRecord {
  pk: string;
  email: string;
  tokenHash: string;
  /** Epoch seconds. */
  createdAt: number;
  /** Epoch seconds. Also the DynamoDB TTL attribute, so expired items are purged. */
  expiresAt: number;
  used: boolean;
  /** Epoch seconds, set when the link is consumed. */
  usedAt?: number;
}

export type NewMagicLink = Omit<MagicLinkRecord, "pk" | "used" | "usedAt">;

export const emailKey = (email: string): string => `EMAIL#${email}`;

export class MagicLinkRepository {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Stores a new link, replacing the previous one, unless the previous link is
   * still unused and was created after `cooldownStart` (epoch seconds). The
   * check and the write are one atomic operation, so parallel requests cannot
   * slip past the cooldown.
   *
   * @returns false when the cooldown prevented the write.
   */
  async save(link: NewMagicLink, cooldownStart: number): Promise<boolean> {
    const record: MagicLinkRecord = { pk: emailKey(link.email), ...link, used: false };
    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: "attribute_not_exists(pk) OR #used = :true OR createdAt <= :cooldownStart",
          ExpressionAttributeNames: { "#used": "used" },
          ExpressionAttributeValues: { ":true": true, ":cooldownStart": cooldownStart },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
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
