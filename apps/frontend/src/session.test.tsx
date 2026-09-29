import { beforeEach, describe, expect, it } from "vitest";
import { session } from "./session";

const TOKENS = { idToken: "a.b.c", accessToken: "x", expiresIn: 3600, tokenType: "Bearer" };

describe("session", () => {
  beforeEach(() => sessionStorage.clear());

  it("round-trips tokens through sessionStorage", () => {
    session.save(TOKENS);
    expect(session.load()).toEqual(TOKENS);
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
