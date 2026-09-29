import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes = 256 bits of entropy, encoded as 64 hex characters. */
export const TOKEN_BYTES = 32;
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Generates a cryptographically secure, URL-safe magic-link token.
 * Uses the OS CSPRNG (never Math.random), and is deliberately NOT a JWT:
 * the token is an opaque secret whose only meaning lives server-side.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/**
 * Only the SHA-256 hash of a token is ever persisted. Because tokens carry
 * 256 bits of entropy, a fast hash is sufficient: brute-forcing the preimage
 * is infeasible, so a leaked table cannot be turned back into working links.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidTokenFormat(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/** Constant-time comparison of two hex digests, avoiding timing side channels. */
export function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function buildMagicLink(callbackUrl: string, email: string, token: string): string {
  const url = new URL(callbackUrl);
  url.searchParams.set("email", email);
  url.searchParams.set("token", token);
  return url.toString();
}
