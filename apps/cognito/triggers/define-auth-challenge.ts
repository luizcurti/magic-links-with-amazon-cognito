import type { DefineAuthChallengeTriggerHandler } from "aws-lambda";

/** A magic-link session may retry the challenge a few times before it is killed. */
export const MAX_ATTEMPTS = 3;

/**
 * DefineAuthChallenge — the state machine of the custom auth flow.
 * Cognito calls it at the start and after every challenge answer, passing the
 * history of the session; we decide what happens next.
 */
export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const { session, userNotFound } = event.request;
  const lastAttempt = session.at(-1);

  const onlyCustomChallenges = session.every((attempt) => attempt.challengeName === "CUSTOM_CHALLENGE");

  if (userNotFound || !onlyCustomChallenges) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else if (lastAttempt?.challengeResult === true) {
    // The magic link was verified: we are done, hand out JWTs.
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (session.length >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  }

  return event;
};
