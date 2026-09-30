import type { SQSBatchItemFailure, SQSHandler, SQSRecord } from "aws-lambda";
import { getDynamoClient, getSesClient } from "../lib/aws-clients.js";
import { numberEnv, requireEnv } from "../lib/env.js";
import { logger, maskEmail } from "../lib/logger.js";
import { queuedLoginRequestSchema } from "../lib/validation.js";
import { MagicLinkRepository } from "../repositories/magic-link.repository.js";
import { SesEmailService } from "../services/email.service.js";
import {
  DEFAULT_COOLDOWN_SECONDS,
  DEFAULT_MAX_COOLDOWN_SECONDS,
  DEFAULT_TTL_SECONDS,
  MagicLinkService,
} from "../services/magic-link.service.js";

/**
 * SQS worker behind POST /login: applies the per-email cooldown, stores the
 * link's hash and emails the link.
 *
 * The records of a batch are processed in parallel (the event source
 * mapping's maximum concurrency is what keeps SES under its sending rate);
 * two requests for the same email in one batch are safe, as issuing is
 * optimistic-concurrency controlled.
 *
 * A message that fails (SES or DynamoDB down, throttling) is reported back and
 * retried by SQS: the undelivered link was removed, or failing that is
 * replaced by the retry of the same message, so the user still gets an email.
 * After the queue's maxReceiveCount it lands in the dead-letter queue. A
 * malformed message is dropped: retrying cannot fix it.
 */
export const handler: SQSHandler = async (event) => {
  const magicLinks = new MagicLinkService({
    repository: new MagicLinkRepository(getDynamoClient(), requireEnv("MAGIC_LINKS_TABLE")),
    emailSender: new SesEmailService(getSesClient(), requireEnv("SES_FROM_ADDRESS")),
    callbackUrl: requireEnv("MAGIC_LINK_CALLBACK_URL"),
    ttlSeconds: numberEnv("MAGIC_LINK_TTL_SECONDS", DEFAULT_TTL_SECONDS),
    cooldownSeconds: numberEnv("MAGIC_LINK_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS),
    maxCooldownSeconds: numberEnv("MAGIC_LINK_MAX_COOLDOWN_SECONDS", DEFAULT_MAX_COOLDOWN_SECONDS),
  });

  async function processRecord(record: SQSRecord): Promise<SQSBatchItemFailure | undefined> {
    const request = queuedLoginRequestSchema.safeParse(parseJson(record.body));
    if (!request.success) {
      logger.error("Dropping malformed login request", { messageId: record.messageId });
      return undefined;
    }

    const { email, requestedAt } = request.data;
    try {
      const result = await magicLinks.requestMagicLink(email, { requestedAt, requestId: record.messageId });
      if (result.status === "SENT") {
        logger.info("Magic link sent", { email: maskEmail(email), expiresAt: result.expiresAt });
      } else {
        logger.info("Magic link not sent", { email: maskEmail(email), reason: result.status });
      }
      return undefined;
    } catch (error) {
      logger.error("Failed to send magic link, will retry", { email: maskEmail(email), error: String(error) });
      return { itemIdentifier: record.messageId };
    }
  }

  const results = await Promise.all(event.Records.map(processRecord));
  return { batchItemFailures: results.filter((failure) => failure !== undefined) };
};

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
