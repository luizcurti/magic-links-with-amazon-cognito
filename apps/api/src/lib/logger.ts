type Level = "info" | "error";

/**
 * Minimal structured (JSON) logger. Never pass raw tokens or JWTs here —
 * log outcomes and masked identifiers only.
 */
function log(level: Level, message: string, context: Record<string, unknown> = {}): void {
  const entry = JSON.stringify({ level, message, ...context, timestamp: new Date().toISOString() });
  if (level === "error") console.error(entry);
  else console.log(entry);
}

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context),
};

/** Masks an email for logs: `luiz@example.com` -> `l***@example.com`. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
