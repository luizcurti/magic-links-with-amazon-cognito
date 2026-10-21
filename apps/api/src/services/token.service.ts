import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits, as 64 hex characters. */
export const TOKEN_BYTES = 32;
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Opaque random token from the OS CSPRNG. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** SHA-256 is enough: a 256-bit random token cannot be brute-forced. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isValidTokenFormat(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

/** Constant-time comparison of two hex digests. */
export function hashesMatch(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Puts email and token in the fragment, which browsers never send to a server. */
export function buildMagicLink(callbackUrl: string, email: string, token: string): string {
  const url = new URL(callbackUrl);
  url.hash = new URLSearchParams({ email, token }).toString();
  return url.toString();
}
