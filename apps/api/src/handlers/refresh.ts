import type { APIGatewayProxyHandler } from "aws-lambda";
import { getCognitoClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { errorResponse, json, parseJsonBody } from "../lib/http.js";
import { refreshTokenRequestSchema, validate } from "../lib/validation.js";
import { AuthenticationError, CognitoService } from "../services/cognito.service.js";

/**
 * POST /auth/refresh  { "refreshToken": "<Cognito refresh token>" }
 *
 * ID and access tokens are short-lived; the frontend calls this to renew them
 * silently. Once /logout revokes the refresh token, this answers 401.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { refreshToken } = validate(refreshTokenRequestSchema, parseJsonBody(event));

    const cognito = new CognitoService(
      getCognitoClient(),
      requireEnv("USER_POOL_ID"),
      requireEnv("USER_POOL_CLIENT_ID"),
    );
    return json(200, await cognito.refreshSession(refreshToken));
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return json(401, { message: error.message });
    }
    return errorResponse(error, "Session refresh failed unexpectedly");
  }
};
