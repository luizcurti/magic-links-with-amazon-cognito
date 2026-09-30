import type { APIGatewayProxyHandler } from "aws-lambda";
import { getCognitoClient, getDynamoClient, getSesClient } from "../lib/aws-clients.js";
import { numberEnv, requireEnv } from "../lib/env.js";
import { errorResponse, json, parseJsonBody } from "../lib/http.js";
import { logger, maskEmail } from "../lib/logger.js";
import { loginRequestSchema, validate } from "../lib/validation.js";
import { MagicLinkRepository } from "../repositories/magic-link.repository.js";
import { CognitoService } from "../services/cognito.service.js";
import { SesEmailService } from "../services/email.service.js";
import { DEFAULT_COOLDOWN_SECONDS, DEFAULT_TTL_SECONDS, MagicLinkService } from "../services/magic-link.service.js";

/**
 * The same response is returned whether or not the email already had an
 * account, so this endpoint cannot be used to enumerate users.
 */
export const GENERIC_RESPONSE = {
  message: "If the email address is valid, a magic link is on its way.",
};

/**
 * POST /login  { "email": "user@example.com" }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { email } = validate(loginRequestSchema, parseJsonBody(event));

    const cognito = new CognitoService(
      getCognitoClient(),
      requireEnv("USER_POOL_ID"),
      requireEnv("USER_POOL_CLIENT_ID"),
    );
    const magicLinks = new MagicLinkService({
      repository: new MagicLinkRepository(getDynamoClient(), requireEnv("MAGIC_LINKS_TABLE")),
      emailSender: new SesEmailService(getSesClient(), requireEnv("SES_FROM_ADDRESS")),
      callbackUrl: requireEnv("MAGIC_LINK_CALLBACK_URL"),
      ttlSeconds: numberEnv("MAGIC_LINK_TTL_SECONDS", DEFAULT_TTL_SECONDS),
      cooldownSeconds: numberEnv("MAGIC_LINK_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS),
    });

    await cognito.ensureUser(email);
    const result = await magicLinks.requestMagicLink(email);

    if (result.status === "SENT") {
      logger.info("Magic link issued", { email: maskEmail(email), expiresAt: result.expiresAt });
    } else {
      logger.info("Magic link not sent: cooldown active", { email: maskEmail(email) });
    }
    return json(202, GENERIC_RESPONSE);
  } catch (error) {
    return errorResponse(error, "Failed to issue magic link");
  }
};
