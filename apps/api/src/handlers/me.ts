import type { APIGatewayProxyHandler } from "aws-lambda";
import { errorResponse, header, json } from "../lib/http.js";
import { InvalidIdTokenError, verifyIdToken } from "../lib/id-token.js";
import { logger, startInvocation } from "../lib/logger.js";

/**
 * GET /me: the claims of the ID token, verified again here after the Cognito
 * authorizer. `sub` identifies the user.
 */
export const handler: APIGatewayProxyHandler = async (event, context) => {
  startInvocation(context, { apiRequestId: event.requestContext?.requestId });
  try {
    const claims = await verifyIdToken(header(event, "authorization"));

    return json(200, {
      sub: claims.sub,
      email: claims.email,
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      authTime: Number(claims.auth_time),
      expiresAt: claims.exp,
    });
  } catch (error) {
    if (error instanceof InvalidIdTokenError) {
      logger.warn("Rejected ID token", { reason: error.reason });
      return json(401, { message: "Unauthorized" });
    }
    return errorResponse(error, "ID token verification failed unexpectedly");
  }
};
