import type { SQSBatchItemFailure, SQSHandler, SQSRecord } from "aws-lambda";
import { getDynamoClient, getSesClient } from "../lib/aws-clients.js";
import { numberEnv, requireEnv } from "../lib/env.js";
import { logger, maskEmail, startInvocation, traceRoot } from "../lib/logger.js";
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
 * SQS worker behind POST /login: cooldown, store the hash, send the email.
 * Records run in parallel. Failed records are retried by SQS (then the DLQ);
 * malformed ones are dropped.
 */
export const handler: SQSHandler = async (event, context) => {
  startInvocation(context);
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
    // sourceTraceId: the POST /login that queued the request.
    const log = {
      email: maskEmail(email),
      messageId: record.messageId,
      sourceTraceId: traceRoot(record.attributes?.AWSTraceHeader),
    };
    try {
      const result = await magicLinks.requestMagicLink(email, { requestedAt, requestId: record.messageId });
      if (result.status === "SENT") {
        logger.info("Magic link sent", { ...log, expiresAt: result.expiresAt });
      } else {
        logger.info("Magic link not sent", { ...log, reason: result.status });
      }
      return undefined;
    } catch (error) {
      logger.error("Failed to send magic link, will retry", { ...log, error: String(error) });
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
