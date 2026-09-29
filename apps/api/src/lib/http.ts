import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN ?? "http://localhost:5173",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  };
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

export function parseJsonBody(event: APIGatewayProxyEvent): unknown {
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
