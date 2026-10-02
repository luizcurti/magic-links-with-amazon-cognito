import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";

/**
 * CreateAuthChallenge: an empty MAGIC_LINK challenge. The answer is the link's
 * token, checked by VerifyAuthChallenge; no parameters, so nothing reveals
 * whether the account exists.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  event.response.publicChallengeParameters = {};
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = "MAGIC_LINK";
  return event;
};
