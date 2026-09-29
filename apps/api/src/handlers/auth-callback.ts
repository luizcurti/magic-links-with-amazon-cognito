import type { APIGatewayProxyHandler } from "aws-lambda";
import { getCognitoClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { BadRequestError, json, parseJsonBody } from "../lib/http.js";
import { logger, maskEmail } from "../lib/logger.js";
import { validate, verifyRequestSchema } from "../lib/validation.js";
import { AuthenticationError, CognitoService } from "../services/cognito.service.js";

/**
 * POST /auth/verify  { "email": "user@example.com", "token": "<64 hex chars>" }
 *
 * Called by the frontend's /auth/callback page with the values from the
 * magic link. Exchanges them for Cognito JWTs via CUSTOM_AUTH.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { email, token } = validate(verifyRequestSchema, parseJsonBody(event));

    const cognito = new CognitoService(
      getCognitoClient(),
      requireEnv("USER_POOL_ID"),
      requireEnv("USER_POOL_CLIENT_ID"),
    );
    const tokens = await cognito.signInWithMagicLink(email, token);

    logger.info("User authenticated with magic link", { email: maskEmail(email) });
    return json(200, tokens);
  } catch (error) {
    if (error instanceof BadRequestError) {
      return json(400, { message: error.message, errors: error.details });
    }
    if (error instanceof AuthenticationError) {
      return json(401, { message: error.message });
    }
    logger.error("Magic link verification failed unexpectedly", { error: String(error) });
    return json(500, { message: "Internal server error" });
  }
};
