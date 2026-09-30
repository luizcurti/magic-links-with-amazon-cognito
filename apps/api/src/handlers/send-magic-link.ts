import type { SQSBatchItemFailure, SQSHandler } from "aws-lambda";
import { getDynamoClient, getSesClient } from "../lib/aws-clients.js";
import { numberEnv, requireEnv } from "../lib/env.js";
import { logger, maskEmail } from "../lib/logger.js";
import { queuedLoginRequestSchema } from "../lib/validation.js";
import { MagicLinkRepository } from "../repositories/magic-link.repository.js";
import { SesEmailService } from "../services/email.service.js";
import { DEFAULT_COOLDOWN_SECONDS, DEFAULT_TTL_SECONDS, MagicLinkService } from "../services/magic-link.service.js";

/**
 * SQS worker behind POST /login: applies the per-email cooldown, stores the
 * link's hash and emails the link.
 *
 * A message that fails (SES or DynamoDB down, throttling) is reported back and
 * retried by SQS; the undelivered link was already removed, so the retry is
 * not swallowed by the cooldown. After the queue's maxReceiveCount it lands in
 * the dead-letter queue. A malformed message is dropped: retrying cannot fix it.
 */
export const handler: SQSHandler = async (event) => {
  const magicLinks = new MagicLinkService({
    repository: new MagicLinkRepository(getDynamoClient(), requireEnv("MAGIC_LINKS_TABLE")),
    emailSender: new SesEmailService(getSesClient(), requireEnv("SES_FROM_ADDRESS")),
    callbackUrl: requireEnv("MAGIC_LINK_CALLBACK_URL"),
    ttlSeconds: numberEnv("MAGIC_LINK_TTL_SECONDS", DEFAULT_TTL_SECONDS),
    cooldownSeconds: numberEnv("MAGIC_LINK_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS),
  });

  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    const request = queuedLoginRequestSchema.safeParse(parseJson(record.body));
    if (!request.success) {
      logger.error("Dropping malformed login request", { messageId: record.messageId });
      continue;
    }

    const { email, requestedAt } = request.data;
    try {
      const result = await magicLinks.requestMagicLink(email, requestedAt);
      if (result.status === "SENT") {
        logger.info("Magic link sent", { email: maskEmail(email), expiresAt: result.expiresAt });
      } else {
        logger.info("Magic link not sent: cooldown active or a newer link exists", { email: maskEmail(email) });
      }
    } catch (error) {
      logger.error("Failed to send magic link, will retry", { email: maskEmail(email), error: String(error) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
