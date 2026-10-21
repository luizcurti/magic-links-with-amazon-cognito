type Level = "info" | "warn" | "error";

/** Fields of the current invocation (a container runs one at a time). */
let invocationContext: Record<string, unknown> = {};

/** Tags every entry with the Lambda request ID (and the X-Ray trace ID) until the next call. */
export function startInvocation(context: { awsRequestId: string }, fields: Record<string, unknown> = {}): void {
  invocationContext = { requestId: context.awsRequestId, ...fields };
}

/** The `Root=` part of an X-Ray trace header (`Root=1-…;Parent=…;Sampled=1`). */
export function traceRoot(header: string | undefined): string | undefined {
  return header?.match(/Root=([^;]+)/)?.[1];
}

/** JSON logger. Never log tokens or JWTs, only outcomes and masked identifiers. */
function log(level: Level, message: string, context: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({
    level,
    message,
    ...invocationContext,
    traceId: traceRoot(process.env._X_AMZN_TRACE_ID),
    ...context,
    timestamp: new Date().toISOString(),
  });
  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};

/** Masks an email for logs: `luiz@example.com` -> `l***@example.com`. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
