import type { APIGatewayProxyHandler } from "aws-lambda";
import { getSqsClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { errorResponse, json, parseJsonBody } from "../lib/http.js";
import { logger, maskEmail, startInvocation } from "../lib/logger.js";
import { loginRequestSchema, validate } from "../lib/validation.js";
import { LoginQueue } from "../services/login-queue.service.js";

/** Same answer for every valid email: no user enumeration. */
export const GENERIC_RESPONSE = {
  message: "If the email address is valid, a magic link is on its way.",
};

/**
 * POST /login {email}: validates and queues the request. No per-email work
 * here, so the response time reveals nothing.
 */
export const handler: APIGatewayProxyHandler = async (event, context) => {
  startInvocation(context, { apiRequestId: event.requestContext?.requestId });
  try {
    const { email } = validate(loginRequestSchema, parseJsonBody(event));

    const requestedAt = Math.floor(Date.now() / 1000);
    await new LoginQueue(getSqsClient(), requireEnv("LOGIN_QUEUE_URL")).enqueue({ email, requestedAt });

    logger.info("Magic link requested", { email: maskEmail(email) });
    return json(202, GENERIC_RESPONSE);
  } catch (error) {
    return errorResponse(error, "Failed to request magic link");
  }
};
