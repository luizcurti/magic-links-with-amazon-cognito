import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { logger } from "./logger.js";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN ?? "http://localhost:5173",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export const RETRY_AFTER_SECONDS = 5;

export function json(statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...DEFAULT_HEADERS, ...headers },
    body: JSON.stringify(body),
  };
}

export function noContent(): APIGatewayProxyResult {
  return { statusCode: 204, headers: DEFAULT_HEADERS, body: "" };
}

/** Error names AWS services use when a caller exceeds a rate limit. */
const THROTTLING_ERRORS = new Set([
  "TooManyRequestsException",
  "ThrottlingException",
  "Throttling",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "RequestThrottled", // SQS
]);

export const isThrottlingError = (error: unknown): boolean =>
  error instanceof Error && THROTTLING_ERRORS.has(error.name);

/**
 * Maps the errors every handler can hit: bad input (400), an AWS dependency
 * still throttling after the SDK's own retries (429), anything else (500,
 * without leaking internals).
 */
export function errorResponse(error: unknown, failureMessage: string): APIGatewayProxyResult {
  if (error instanceof BadRequestError) {
    return json(400, { message: error.message, errors: error.details });
  }
  if (error instanceof UnsupportedMediaTypeError) {
    return json(415, { message: error.message });
  }
  if (isThrottlingError(error)) {
    logger.warn(`${failureMessage}: throttled by AWS`, { error: String(error) });
    return json(
      429,
      { message: "Too many requests, please try again shortly" },
      { "Retry-After": String(RETRY_AFTER_SECONDS) },
    );
  }
  logger.error(failureMessage, { error: String(error) });
  return json(500, { message: "Internal server error" });
}

export class BadRequestError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor() {
    super("Content-Type must be application/json");
    this.name = "UnsupportedMediaTypeError";
  }
}

export function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

/**
 * Only `application/json` is accepted. A browser sends it cross-site only
 * after a CORS preflight, which a foreign origin fails; a `text/plain` body
 * needs none, so accepting it would let any web page make its visitors'
 * browsers request magic links, spreading the load past per-IP rate limits.
 */
export function parseJsonBody(event: APIGatewayProxyEvent): unknown {
  const mediaType = header(event, "content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new UnsupportedMediaTypeError();
  }
  if (!event.body) {
    throw new BadRequestError("Request body is required");
  }

  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;

  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
}
