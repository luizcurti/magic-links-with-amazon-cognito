import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../session";
import { ProfilePage } from "./ProfilePage";

const base64url = (value: object) =>
  btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const ID_TOKEN = `${base64url({ alg: "RS256" })}.${base64url({ email: "luiz@example.com", "custom:x": "a?b>" })}.sig`;
const TOKENS = { idToken: ID_TOKEN, accessToken: "access", expiresIn: 3600, tokenType: "Bearer" };
const PROFILE = { sub: "sub-1", email: "luiz@example.com", authTime: "1", expiresAt: "2" };

describe("ProfilePage", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/profile");
  });

  it("sends signed-out visitors to the login page", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ProfilePage />);

    expect(window.location.pathname).toBe("/");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls /me with the ID token and shows the profile and claims", async () => {
    session.save(TOKENS);
    const fetchMock = vi.fn().mockResolvedValue(Response.json(PROFILE));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProfilePage />);

    expect(await screen.findByText("luiz@example.com", { selector: "strong" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: ID_TOKEN }) }),
    );
    expect(screen.getByText(/"custom:x": "a\?b>"/)).toBeTruthy();
  });

  it("drops an expired or revoked session", async () => {
    session.save(TOKENS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "Unauthorized" }, { status: 401 })));

    render(<ProfilePage />);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(session.load()).toBeUndefined();
  });

  it("keeps the session and shows other errors", async () => {
    session.save(TOKENS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 502 })));

    render(<ProfilePage />);

    expect(await screen.findByText("Request failed with status 502")).toBeTruthy();
    expect(session.load()).toEqual(TOKENS);
  });

  it("shows no claims for a malformed ID token", async () => {
    session.save({ ...TOKENS, idToken: "not-a-jwt" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(PROFILE)));

    render(<ProfilePage />);

    expect(await screen.findByText("{}")).toBeTruthy();
  });

  it("signs out", async () => {
    session.save(TOKENS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(PROFILE)));
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(session.load()).toBeUndefined();
    expect(window.location.pathname).toBe("/");
  });
});
