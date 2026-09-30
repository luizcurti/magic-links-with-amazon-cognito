import type { APIGatewayProxyHandler } from "aws-lambda";
import { errorResponse, header, json } from "../lib/http.js";
import { InvalidIdTokenError, verifyIdToken } from "../lib/id-token.js";
import { logger } from "../lib/logger.js";

/**
 * GET /me — protected by an API Gateway Cognito authorizer, and the ID token
 * is verified again here (see lib/id-token.ts), so every claim returned below
 * is proven by the pool's signature. This endpoint proves the issued JWTs work.
 *
 * Identify users by `sub`, which never changes. `email` is only trustworthy
 * together with `emailVerified`.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
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
