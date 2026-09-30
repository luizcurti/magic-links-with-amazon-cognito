import type { APIGatewayProxyHandler } from "aws-lambda";
import { getSqsClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { errorResponse, json, parseJsonBody } from "../lib/http.js";
import { logger, maskEmail } from "../lib/logger.js";
import { loginRequestSchema, validate } from "../lib/validation.js";
import { LoginQueue } from "../services/login-queue.service.js";

/**
 * The same response is returned for every valid email, whether or not it has
 * an account or is inside its cooldown, so this endpoint cannot be used to
 * enumerate users or probe their activity.
 */
export const GENERIC_RESPONSE = {
  message: "If the email address is valid, a magic link is on its way.",
};

/**
 * POST /login  { "email": "user@example.com" }
 *
 * Only validates and queues the request: the send-magic-link worker applies
 * the cooldown, stores the link and sends the email. Doing no per-email work
 * here keeps the response time identical in every case (no timing side
 * channel), and creates no Cognito user for addresses nobody verifies.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
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
