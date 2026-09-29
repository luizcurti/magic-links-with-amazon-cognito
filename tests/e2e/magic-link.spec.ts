import { expect, type Page, test } from "@playwright/test";
import { uniqueEmail, waitForMagicLink } from "../integration/stack.js";

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

/** The link opened in the browser, i.e. what the user clicks in their inbox. */
const inBrowser = (link: URL) => `${link.pathname}${link.search}`;

test.describe("happy path", () => {
  test("sign in with a magic link, see the profile, sign out", async ({ page }) => {
    const email = uniqueEmail("e2e");
    const link = await requestLinkInBrowser(page, email);

    await page.goto(inBrowser(link));

    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
    await expect(page.locator("pre")).toContainText(`"email": "${email}"`);
    expect(page.url()).toBe("http://localhost:5173/profile");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.goto("/profile");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("the token never stays in the address bar or history", async ({ page }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("history"));

    await page.goto(inBrowser(link));
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();

    await page.goBack();
    expect(page.url()).not.toContain("token=");
  });

  test("the page never sends the link in a Referer header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  });
});

test.describe("sad path", () => {
  test("a link opened twice works only the first time", async ({ page, browser }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("twice"));
    await page.goto(inBrowser(link));
    await expect(page.getByRole("heading", { name: "You are signed in" })).toBeVisible();

    const other = await browser.newPage();
    await other.goto(`http://localhost:5173${inBrowser(link)}`);

    await expect(other.getByText("This link is invalid, expired or has already been used.")).toBeVisible();
    expect(other.url()).not.toContain("token=");
    await other.close();
  });

  test("a tampered token is rejected and the user can start over", async ({ page }) => {
    const link = await requestLinkInBrowser(page, uniqueEmail("tampered"));
    link.searchParams.set("token", "0".repeat(64));

    await page.goto(inBrowser(link));

    await expect(page.getByRole("heading", { name: "Sign-in failed" })).toBeVisible();
    await page.getByRole("button", { name: "Request a new link" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("an incomplete link does not call the API", async ({ page }) => {
    let verifyCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/auth/verify")) verifyCalls++;
    });

    await page.goto("/auth/callback?email=someone%40example.com");

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
