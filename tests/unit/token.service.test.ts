import { describe, expect, it } from "vitest";
import {
  buildMagicLink,
  generateToken,
  hashesMatch,
  hashToken,
  isValidTokenFormat,
  TOKEN_PATTERN,
} from "../../apps/api/src/services/token.service.js";

describe("token generation", () => {
  it("generates 256-bit tokens encoded as 64 hex characters", () => {
    const token = generateToken();
    expect(token).toMatch(TOKEN_PATTERN);
    expect(token).toHaveLength(64);
  });

  it("never repeats tokens", () => {
    const tokens = new Set(Array.from({ length: 1_000 }, generateToken));
    expect(tokens.size).toBe(1_000);
  });
});

describe("token hashing", () => {
  it("produces a deterministic SHA-256 digest", () => {
    // echo -n "hello" | shasum -a 256
    expect(hashToken("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("never returns the token itself", () => {
    const token = generateToken();
    expect(hashToken(token)).not.toBe(token);
  });

  it("compares hashes in constant time and rejects different lengths", () => {
    const hash = hashToken("a");
    expect(hashesMatch(hash, hashToken("a"))).toBe(true);
    expect(hashesMatch(hash, hashToken("b"))).toBe(false);
    expect(hashesMatch(hash, "abcd")).toBe(false);
  });
});

describe("token format", () => {
  it.each([
    ["valid token", "a".repeat(64), true],
    ["too short", "a".repeat(63), false],
    ["uppercase", "A".repeat(64), false],
    ["non-hex", "z".repeat(64), false],
    ["not a string", 42, false],
  ])("%s", (_label, value, expected) => {
    expect(isValidTokenFormat(value)).toBe(expected);
  });
});

describe("magic link", () => {
  it("url-encodes email and token as query parameters", () => {
    const link = buildMagicLink("http://localhost:5173/auth/callback", "luiz+test@example.com", "abc");
    const url = new URL(link);
    expect(url.pathname).toBe("/auth/callback");
    expect(url.searchParams.get("email")).toBe("luiz+test@example.com");
    expect(url.searchParams.get("token")).toBe("abc");
  });
});
