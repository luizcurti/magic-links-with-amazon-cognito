import type { APIGatewayProxyHandler } from "aws-lambda";
import { getCognitoClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { errorResponse, noContent, parseJsonBody } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { refreshTokenRequestSchema, validate } from "../lib/validation.js";
import { CognitoService } from "../services/cognito.service.js";

/**
 * POST /logout  { "refreshToken": "<Cognito refresh token>" }
 *
 * Revokes the session's refresh token so it can no longer mint new tokens.
 * Holding the refresh token is the proof of ownership, so the route needs no
 * authorizer (an expired ID token must not prevent signing out).
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { refreshToken } = validate(refreshTokenRequestSchema, parseJsonBody(event));

    const cognito = new CognitoService(
      getCognitoClient(),
      requireEnv("USER_POOL_ID"),
      requireEnv("USER_POOL_CLIENT_ID"),
    );
    const revoked = await cognito.revokeRefreshToken(refreshToken);

    if (revoked) logger.info("Refresh token revoked");
    else logger.warn("Sign-out with a refresh token Cognito does not recognise");
    return noContent();
  } catch (error) {
    return errorResponse(error, "Sign-out failed unexpectedly");
  }
};
