import type { APIGatewayProxyHandler } from "aws-lambda";
import { getCognitoClient } from "../lib/aws-clients.js";
import { requireEnv } from "../lib/env.js";
import { errorResponse, json, parseJsonBody } from "../lib/http.js";
import { startInvocation } from "../lib/logger.js";
import { refreshTokenRequestSchema, validate } from "../lib/validation.js";
import { AuthenticationError, CognitoService } from "../services/cognito.service.js";

/** POST /auth/refresh {refreshToken}: new ID and access tokens, 401 once revoked. */
export const handler: APIGatewayProxyHandler = async (event, context) => {
  startInvocation(context, { apiRequestId: event.requestContext?.requestId });
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
