import { CognitoIdentityProviderClient, InitiateAuthCommand } from "@aws-sdk/client-cognito-identity-provider";
import { expect, type Page, test } from "@playwright/test";
import { LOCALSTACK_ENDPOINT, linkParams, loadStack, uniqueEmail, waitForMagicLink } from "../integration/stack.js";

const cognito = new CognitoIdentityProviderClient({
  endpoint: LOCALSTACK_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const refresh = (refreshToken: string) =>
  cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: loadStack()?.clientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  );

/** Types the email on the login page and returns the magic link it produced. */
async function requestLinkInBrowser(page: Page, email: string): Promise<URL> {
  const sentAfter = new Date(Date.now() - 1_000);
  await page.goto("/");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send magic link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  return waitForMagicLink(email, sentAfter);
}

/** Makes the stored session look expired, as if the tab had been open for 15 minutes. */
const expireStoredSession = (page: Page) =>
  page.evaluate(() => {
    const key = "magic-links.session";
    const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}");
    sessionStorage.setItem(key, JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }));
  });

/** The link opened in the browser, i.e. what the user clicks in their inbox. */
const inBrowser = (link: URL) => `${link.pathname}${link.hash}`;

/** Opens the link and confirms the sign-in, as the user does. */
async function openAndConfirm(page: Page, link: URL) {
  await page.goto(inBrowser(link));
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("happy path", () => {
  test("sign in with a magic link, see the profile, sign out", async ({ page }) => {
    const email = uniqueEmail("e2e");
    const link = await requestLinkInBrowser(page, email);

    await page.goto(inBrowser(link));
    await expect(page.getByText(`Sign in as ${email}?`)).toBeVisible();
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.locator("pre")).toContainText(`"email": "${email}"`);
    expect(page.url()).toBe("http://localhost:5173/profile");

    const refreshToken = await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("magic-links.session") ?? "{}").refreshToken as string,
    );
    await expect(refresh(refreshToken)).resolves.toHaveProperty("AuthenticationResult.AccessToken");

    const logout = page.waitForResponse((response) => response.url().endsWith("/api/logout"));
    await page.getByRole("button", { name: "Sign out" }).click();
    expect((await logout).status()).toBe(204);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    // The session is gone from the browser and the refresh token is dead server-side.
    expect(await page.evaluate(() => sessionStorage.getItem("magic-links.session"))).toBeNull();
    await expect(refresh(refreshToken)).rejects.toThrow(/revoked/i);

    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("an expired session is renewed silently", async ({ page }) => {
    const email = uniqueEmail("renew");
    const link = await requestLinkInBrowser(page, email);
    await openAndConfirm(page, link);
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();

    await expireStoredSession(page);
    const renewal = page.waitForResponse((response) => response.url().endsWith("/api/auth/refresh"));
    await page.reload();

    expect((await renewal).status()).toBe(200);
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem("magic-links.session") ?? "{}").expiresAt),
    ).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  test("the token never stays in the address bar or history", async ({ page }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("history"));

    await openAndConfirm(page, link);
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();

    await page.goBack();
    expect(page.url()).not.toContain("token=");
  });

  test("no other site can frame the app (clickjacking the Sign in button)", async ({ page }) => {
    const response = await page.goto("/auth/callback");
    const headers = response?.headers() ?? {};

    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  test("the page never sends the link in a Referer header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  });
});

test.describe("sad path", () => {
  test("a session revoked elsewhere cannot be renewed and goes back to login", async ({ page, request }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("revoked"));
    await openAndConfirm(page, link);
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();

    // Sign out from "another device": revoke the same refresh token through the API.
    const refreshToken = await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("magic-links.session") ?? "{}").refreshToken as string,
    );
    expect((await request.post("/api/logout", { data: { refreshToken } })).status()).toBe(204);

    await expireStoredSession(page);
    await page.reload();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("magic-links.session"))).toBeNull();
  });

  test("opening a link does not use it: a mail scanner visiting it cannot burn it", async ({ page, browser }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("scanner"));
    let verifyCalls = 0;

    const scanner = await browser.newPage();
    scanner.on("request", (request) => {
      if (request.url().includes("/api/auth/verify")) verifyCalls++;
    });
    await scanner.goto(`http://localhost:5173${inBrowser(link)}`);
    await expect(scanner.getByRole("heading", { name: "Confirm sign-in" })).toBeVisible();
    await scanner.close();
    expect(verifyCalls).toBe(0);

    await openAndConfirm(page, link);
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();
  });

  test("a link opened twice works only the first time", async ({ page, browser }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("twice"));
    await openAndConfirm(page, link);
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();

    const other = await browser.newPage();
    await other.goto(`http://localhost:5173${inBrowser(link)}`);
    await other.getByRole("button", { name: "Sign in" }).click();

    await expect(other.getByText("This link is invalid, expired or has already been used.")).toBeVisible();
    expect(other.url()).not.toContain("token=");
    await other.close();
  });

  test("a tampered token is rejected and the user can start over", async ({ page }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("tampered"));
    const params = linkParams(link);
    params.set("token", "0".repeat(64));
    link.hash = params.toString();

    await openAndConfirm(page, link);

    await expect(page.getByRole("heading", { name: "Sign-in failed" })).toBeVisible();
    await page.getByRole("button", { name: "Request a new link" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("an incomplete link does not call the API", async ({ page }) => {
    let verifyCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/verify")) verifyCalls++;
    });

    await page.goto("/auth/callback#email=someone%40example.com");

    await expect(page.getByText("This link is incomplete. Please request a new one.")).toBeVisible();
    expect(verifyCalls).toBe(0);
  });

  test("the browser refuses an invalid email before calling the API", async ({ page }) => {
    let loginCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/login")) loginCalls++;
    });

    await page.goto("/");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Send magic link" }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(loginCalls).toBe(0);
  });
});
