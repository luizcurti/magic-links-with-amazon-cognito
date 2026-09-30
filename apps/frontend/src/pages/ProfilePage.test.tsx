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

  it("signs out when the API rejects even a freshly renewed token", async () => {
    session.save({ ...TOKENS, refreshToken: "refresh-1" });
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/auth/refresh"
        ? Response.json({ idToken: ID_TOKEN, accessToken: "a2", expiresIn: 900, tokenType: "Bearer" })
        : Response.json({ message: "Unauthorized" }, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ProfilePage />);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(session.load()).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/me", "/api/auth/refresh", "/api/me"]);
  });

  it("silently renews an expired session and shows the renewed token's claims", async () => {
    const renewedIdToken = `${base64url({ alg: "RS256" })}.${base64url({ email: "luiz@example.com", renewed: true })}.sig`;
    sessionStorage.setItem(
      "magic-links.session",
      JSON.stringify({ ...TOKENS, refreshToken: "refresh-1", expiresAt: Date.now() - 1 }),
    );
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/auth/refresh"
        ? Response.json({ idToken: renewedIdToken, accessToken: "a2", expiresIn: 900, tokenType: "Bearer" })
        : Response.json(PROFILE),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ProfilePage />);

    expect(await screen.findByText(/"renewed": true/)).toBeTruthy();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/me",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: renewedIdToken }) }),
    );
    expect(window.location.pathname).toBe("/profile");
  });

  it("goes back to login when the session can no longer be renewed", async () => {
    sessionStorage.setItem(
      "magic-links.session",
      JSON.stringify({ ...TOKENS, refreshToken: "revoked", expiresAt: Date.now() - 1 }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "revoked" }, { status: 401 })));

    render(<ProfilePage />);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(session.load()).toBeUndefined();
  });

  it("keeps the session and shows other errors", async () => {
    session.save(TOKENS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("oops", { status: 502 })));

    render(<ProfilePage />);

    expect(await screen.findByText("Request failed with status 502")).toBeTruthy();
    expect(session.load()).toMatchObject(TOKENS);
  });

  it("shows no claims for a malformed ID token", async () => {
    session.save({ ...TOKENS, idToken: "not-a-jwt" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(PROFILE)));

    render(<ProfilePage />);

    expect(await screen.findByText("{}")).toBeTruthy();
  });

  it("signs out without calling the API when there is no refresh token", async () => {
    session.save(TOKENS);
    const fetchMock = vi.fn().mockResolvedValue(Response.json(PROFILE));
    vi.stubGlobal("fetch", fetchMock);
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(session.load()).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("revokes the refresh token on the server before signing out", async () => {
    session.save({ ...TOKENS, refreshToken: "refresh-1" });
    let finishLogout: (response: Response) => void = () => {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(PROFILE))
      .mockReturnValueOnce(new Promise<Response>((resolve) => (finishLogout = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("button", { name: "Signing out…" })).toHaveProperty("disabled", true);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/logout",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ refreshToken: "refresh-1" }) }),
    );

    finishLogout(new Response(null, { status: 204 }));
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(session.load()).toBeUndefined();
  });

  it("still signs out locally when the server cannot revoke", async () => {
    session.save({ ...TOKENS, refreshToken: "refresh-1" });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(PROFILE))
        .mockResolvedValueOnce(Response.json({ message: "Too many requests" }, { status: 429 })),
    );
    render(<ProfilePage />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(session.load()).toBeUndefined();
  });
});
