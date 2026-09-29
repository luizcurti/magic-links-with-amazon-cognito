import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";

/**
 * CreateAuthChallenge — defines the challenge presented to the client.
 *
 * Unlike the original article, nothing is generated or emailed here: the
 * magic link was already issued by POST /login. The "answer" is the token
 * from the link, and it is checked against DynamoDB in VerifyAuthChallenge,
 * so no secret needs to travel in privateChallengeParameters.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  event.response.publicChallengeParameters = {
    email: event.request.userAttributes.email ?? "",
  };
  event.response.privateChallengeParameters = {};
  event.response.challengeMetadata = "MAGIC_LINK";
  return event;
};
