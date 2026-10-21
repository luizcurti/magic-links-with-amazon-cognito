import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import { getDynamoClient } from "../../api/src/lib/aws-clients.js";
import { requireEnv } from "../../api/src/lib/env.js";
import { logger, maskEmail, startInvocation } from "../../api/src/lib/logger.js";
import { MagicLinkRepository } from "../../api/src/repositories/magic-link.repository.js";
import { MagicLinkService } from "../../api/src/services/magic-link.service.js";

/**
 * VerifyAuthChallengeResponse: consumes the magic link. The email comes from
 * Cognito's user attributes, never from the client.
 */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event, context) => {
  startInvocation(context);
  const email = event.request.userAttributes.email?.toLowerCase();
  const token = event.request.challengeAnswer;

  // Decoy challenge: no answer is ever right.
  if (event.request.userNotFound || !email) {
    event.response.answerCorrect = false;
    return event;
  }

  const service = new MagicLinkService({
    repository: new MagicLinkRepository(getDynamoClient(), requireEnv("MAGIC_LINKS_TABLE")),
  });

  const result = await service.consumeMagicLink(email, token);
  event.response.answerCorrect = result === "VALID";

  logger.info("Magic link verification", { email: maskEmail(email), result });
  return event;
};
