import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";
import { getDynamoClient } from "../../api/src/lib/aws-clients.js";
import { requireEnv } from "../../api/src/lib/env.js";
import { logger, maskEmail } from "../../api/src/lib/logger.js";
import { MagicLinkRepository } from "../../api/src/repositories/magic-link.repository.js";
import { MagicLinkService } from "../../api/src/services/magic-link.service.js";

/**
 * VerifyAuthChallengeResponse — decides whether the answer (the magic-link
 * token) is correct.
 *
 * The email is taken from Cognito's own user attributes, not from anything
 * the client sent, so a token issued for one address can never authenticate
 * a different account.
 */
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email?.toLowerCase();
  const token = event.request.challengeAnswer;

  // Unknown users get a decoy challenge (see DefineAuthChallenge); no answer is ever right.
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
