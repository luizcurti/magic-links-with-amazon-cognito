import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { navigate } from "./router";
import { session } from "./session";

describe("App routing", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
  });

  it.each([
    ["/", "Sign in"],
    ["/unknown", "Sign in"],
    ["/auth/callback", "Signing you in…"],
  ])("renders the page for %s", (path, heading) => {
    window.history.replaceState({}, "", `${path}?email=a%40b.com&token=${"a".repeat(64)}`);
    render(<App />);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
  });

  it("shows the login page when a signed-out visitor opens /profile", () => {
    window.history.replaceState({}, "", "/profile");
    render(<App />);

    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("follows client-side navigation", () => {
    session.save({ idToken: "a.b.c", accessToken: "x", expiresIn: 1, tokenType: "Bearer" });
    window.history.replaceState({}, "", "/");
    render(<App />);

    act(() => navigate("/profile"));

    expect(screen.getByRole("heading", { name: "You are signed in" })).toBeTruthy();
  });
});
