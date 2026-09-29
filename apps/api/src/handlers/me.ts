import type { APIGatewayProxyHandler } from "aws-lambda";
import { json } from "../lib/http.js";

/**
 * GET /me — protected by an API Gateway Cognito authorizer.
 *
 * By the time this runs, API Gateway has already validated the ID token's
 * signature, issuer, audience and expiry; the verified claims are forwarded
 * in the request context. This endpoint proves the issued JWTs actually work.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const claims = (event.requestContext.authorizer?.claims ?? {}) as Record<string, string>;

  if (!claims.sub) {
    return json(401, { message: "Unauthorized" });
  }

  return json(200, {
    sub: claims.sub,
    email: claims.email,
    authTime: claims.auth_time,
    expiresAt: claims.exp,
  });
};
