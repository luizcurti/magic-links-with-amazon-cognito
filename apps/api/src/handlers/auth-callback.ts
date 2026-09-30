import type { APIGatewayProxyHandler } from "aws-lambda";
import { getCognitoClient, getDynamoClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { errorResponse, json, parseJsonBody } from "../lib/http.js";
import { logger, maskEmail } from "../lib/logger.js";
import { validate, verifyRequestSchema } from "../lib/validation.js";
import { MagicLinkRepository } from "../repositories/magic-link.repository.js";
import { AuthenticationError, CognitoService } from "../services/cognito.service.js";
import { MagicLinkService } from "../services/magic-link.service.js";

/**
 * POST /auth/verify  { "email": "user@example.com", "token": "<64 hex chars>" }
 *
 * Called by the frontend's /auth/callback page with the values from the
 * magic link. Exchanges them for Cognito JWTs via CUSTOM_AUTH.
 *
 * The link is checked (read-only) first: a bad link is turned away without
 * calling Cognito, which spares its shared auth quota, and the Cognito user is
 * only created here, once someone has proved they own the address. The
 * VerifyAuthChallenge trigger then consumes the link atomically, and remains
 * the only authority on whether it is valid.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { email, token } = validate(verifyRequestSchema, parseJsonBody(event));

    const magicLinks = new MagicLinkService({
      repository: new MagicLinkRepository(getDynamoClient(), requireEnv("MAGIC_LINKS_TABLE")),
    });
    const check = await magicLinks.checkMagicLink(email, token);
    if (check !== "VALID") {
      logger.info("Magic link rejected", { email: maskEmail(email), result: check });
      throw new AuthenticationError();
    }

    const cognito = new CognitoService(
      getCognitoClient(),
      requireEnv("USER_POOL_ID"),
      requireEnv("USER_POOL_CLIENT_ID"),
    );
    await cognito.ensureUser(email);
    const tokens = await cognito.signInWithMagicLink(email, token);

    logger.info("User authenticated with magic link", { email: maskEmail(email) });
    return json(200, tokens);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return json(401, { message: error.message });
    }
    return errorResponse(error, "Magic link verification failed unexpectedly");
  }
};
