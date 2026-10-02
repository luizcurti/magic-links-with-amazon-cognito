import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../session";
import { CallbackPage } from "./CallbackPage";

const TOKENS = { idToken: "a.b.c", accessToken: "access", expiresIn: 3600, tokenType: "Bearer" };
const TOKEN = "ab".repeat(32);

/** Opens the callback page the way the email link does: parameters in the fragment. */
function openLink(fragment = `#email=luiz%40example.com&token=${TOKEN}`) {
  window.history.replaceState({}, "", `/auth/callback${fragment}`);
}

function mockVerify(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const clickSignIn = async () => (await screen.findByRole("button", { name: "Sign in" })).click();

describe("CallbackPage", () => {
  beforeEach(() => sessionStorage.clear());

  it("verifies nothing until the user confirms who they are signing in as", async () => {
    openLink();
    const fetchMock = mockVerify(Response.json(TOKENS));

    render(
      <StrictMode>
        <CallbackPage />
      </StrictMode>,
    );

    expect(await screen.findByText("luiz@example.com")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exchanges the link once on click and opens the profile", async () => {
    openLink();
    const fetchMock = mockVerify(Response.json(TOKENS));

    render(
      <StrictMode>
        <CallbackPage />
      </StrictMode>,
    );
    await clickSignIn();

    await waitFor(() => expect(window.location.pathname).toBe("/profile"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/verify",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "luiz@example.com", token: TOKEN }) }),
    );
    expect(session.load()).toMatchObject(TOKENS);
  });

  it("removes the token from the address bar as soon as the page opens", () => {
    openLink();
    render(<CallbackPage />);

    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");
  });

  it("still accepts a link that carries its parameters in the query string", async () => {
    openLink(`?email=luiz%40example.com&token=${TOKEN}`);
    const fetchMock = mockVerify(Response.json(TOKENS));

    render(<CallbackPage />);
    await clickSignIn();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(window.location.search).toBe("");
  });

  it("explains a rejected link and keeps no session", async () => {
    openLink();
    mockVerify(Response.json({ message: "Invalid or expired magic link" }, { status: 401 }));

    render(<CallbackPage />);
    await clickSignIn();

    expect(await screen.findByText("This link is invalid, expired or has already been used.")).toBeTruthy();
    expect(session.load()).toBeUndefined();
  });

  it.each([
    ["no token", "#email=luiz%40example.com"],
    ["no email", `#token=${TOKEN}`],
    ["no parameters", ""],
  ])("rejects an incomplete link (%s) without calling the API", async (_label, fragment) => {
    openLink(fragment);
    const fetchMock = mockVerify(Response.json(TOKENS));

    render(<CallbackPage />);

    expect(await screen.findByText("This link is incomplete. Please request a new one.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets the user go back and request a new link", async () => {
    openLink("");
    render(<CallbackPage />);

    (await screen.findByRole("button", { name: "Request a new link" })).click();

    expect(window.location.pathname).toBe("/");
  });

  it.each([
    ["success", () => Response.json(TOKENS)],
    ["failure", () => Response.json({ message: "Invalid" }, { status: 401 })],
  ])("ignores a late %s once the page was left", async (_label, response) => {
    openLink();
    let resolve: (response: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r))));

    const { unmount } = render(<CallbackPage />);
    await clickSignIn();
    unmount();
    resolve(response());
    await new Promise((r) => setTimeout(r, 0));

    expect(session.load()).toBeUndefined();
    expect(window.location.pathname).toBe("/auth/callback");
  });
});
