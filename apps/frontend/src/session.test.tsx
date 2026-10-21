import { beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "./session";

const TOKENS = { idToken: "a.b.c", accessToken: "x", expiresIn: 3600, tokenType: "Bearer" };

describe("session", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips tokens through sessionStorage with their expiry time", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(session.save(TOKENS)).toEqual({ ...TOKENS, expiresAt: 1_000_000 + 3_600_000 });
    expect(session.load()).toEqual({ ...TOKENS, expiresAt: 4_600_000 });
  });

  it("is empty after sign-out", () => {
    session.save(TOKENS);
    session.clear();
    expect(session.load()).toBeUndefined();
  });

  it("treats corrupted storage as signed out", () => {
    sessionStorage.setItem("magic-links.session", "{not json");
    expect(session.load()).toBeUndefined();
  });
});
