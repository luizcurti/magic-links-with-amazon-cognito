import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";

/** The only challenge parameter: a constant, identical for real and unknown users. */
export const CHALLENGE = { challenge: "MAGIC_LINK" } as const;

/**
 * CreateAuthChallenge: a MAGIC_LINK challenge. The answer is the link's token,
 * checked by VerifyAuthChallenge. The parameters are a constant, so nothing
 * reveals whether the account exists. They must not be empty: real Cognito
 * rejects an empty challenge with NotAuthorizedException ("Incorrect username
 * or password"), although LocalStack accepts it.
 */
export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  event.response.publicChallengeParameters = { ...CHALLENGE };
  event.response.privateChallengeParameters = { ...CHALLENGE };
  event.response.challengeMetadata = "MAGIC_LINK";
  return event;
};
