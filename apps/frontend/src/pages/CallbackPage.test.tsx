import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { session } from "../session";
import { CallbackPage } from "./CallbackPage";

const TOKENS = { idToken: "a.b.c", accessToken: "access", expiresIn: 3600, tokenType: "Bearer" };

let counter = 0;
/** Each test uses its own token: verification promises are cached per token at module level. */
function openLink(query?: string) {
  const token = (counter++).toString(16).padStart(64, "0");
  window.history.replaceState({}, "", `/auth/callback${query ?? `?email=luiz%40example.com&token=${token}`}`);
  return token;
}

function mockVerify(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("CallbackPage", () => {
  beforeEach(() => sessionStorage.clear());

  it("exchanges the link once, even under StrictMode, and opens the profile", async () => {
    const token = openLink();
    const fetchMock = mockVerify(Response.json(TOKENS));

    render(
      <StrictMode>
        <CallbackPage />
      </StrictMode>,
    );

    await waitFor(() => expect(window.location.pathname).toBe("/profile"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/verify",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "luiz@example.com", token }) }),
    );
    expect(session.load()).toMatchObject(TOKENS);
  });

  it("removes the token from the address bar before calling the API", () => {
    openLink();
    mockVerify(new Response(null, { status: 401 }));

    render(<CallbackPage />);

    expect(window.location.search).toBe("");
  });

  it("explains a rejected link and keeps no session", async () => {
    openLink();
    mockVerify(Response.json({ message: "Invalid or expired magic link" }, { status: 401 }));

    render(<CallbackPage />);

    expect(await screen.findByText("This link is invalid, expired or has already been used.")).toBeTruthy();
    expect(session.load()).toBeUndefined();
    expect(window.location.search).toBe("");
  });

  it.each([
    ["no token", "?email=luiz%40example.com"],
    ["no email", `?token=${"a".repeat(64)}`],
    ["no parameters", ""],
  ])("rejects an incomplete link (%s) without calling the API", async (_label, query) => {
    openLink(query);
    const fetchMock = mockVerify(Response.json(TOKENS));

    render(<CallbackPage />);

    expect(await screen.findByText("This link is incomplete. Please request a new one.")).toBeTruthy();
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
    unmount();
    resolve(response());
    await new Promise((r) => setTimeout(r, 0));

    expect(session.load()).toBeUndefined();
    expect(window.location.pathname).toBe("/auth/callback");
  });
});
