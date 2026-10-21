/**
 * Every screen and every API answer it handles (make up && make infra).
 * 429, 500 and network failures are injected with page.route on one call.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { expect, type Page, test } from "@playwright/test";
import { LOCALSTACK_ENDPOINT, loadStack, uniqueEmail, waitForMagicLink } from "../integration/stack.js";

const SESSION_KEY = "magic-links.session";
const BAD_LINK = "This link is invalid, expired or has already been used.";
const INCOMPLETE_LINK = "This link is incomplete. Please request a new one.";

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    endpoint: LOCALSTACK_ENDPOINT,
    region: "us-east-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  }),
);

const loginHeading = (page: Page) => page.getByRole("heading", { name: "Sign in", exact: true });
const signedInHeading = (page: Page) => page.getByRole("heading", { name: "You are signed in" });
const sendButton = (page: Page) => page.getByRole("button", { name: "Send magic link" });

/** Types `typed` on the login page and returns the link delivered to `mailbox`. */
async function requestLink(page: Page, typed: string, mailbox = typed): Promise<URL> {
  const sentAfter = new Date(Date.now() - 1_000);
  await page.goto("/");
  await page.getByLabel("Email").fill(typed);
  await sendButton(page).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  return waitForMagicLink(mailbox, sentAfter);
}

const inBrowser = (link: URL) => `${link.pathname}${link.hash}`;

async function signIn(page: Page, label: string) {
  const email = uniqueEmail(label);
  const link = await requestLink(page, email);
  await page.goto(inBrowser(link));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(signedInHeading(page)).toBeVisible();
  return email;
}

/** Answers the next call to `path` with `status` and `body` instead of the API. */
const fakeOnce = (page: Page, path: string, status: number, body: unknown) =>
  page.route(
    `**/api${path}`,
    (route) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) }),
    { times: 1 },
  );

/** Holds the next call to `pattern` until the returned function is called. */
async function holdNext(page: Page, pattern: string): Promise<() => void> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    pattern,
    async (route) => {
      await gate;
      await route.continue();
    },
    { times: 1 },
  );
  return release;
}

const storedSession = (page: Page) => page.evaluate((key) => sessionStorage.getItem(key), SESSION_KEY);

/** Counts the browser's calls to an API path. */
function countCalls(page: Page, path: string) {
  const counter = { count: 0 };
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api${path}`) counter.count++;
  });
  return counter;
}

test.describe("routing", () => {
  for (const path of ["/", "/does-not-exist", "/auth", "/profile/extra"]) {
    test(`${path} shows the login page`, async ({ page }) => {
      await page.goto(path);
      await expect(loginHeading(page)).toBeVisible();
    });
  }

  test("/profile without a session goes to the login page", async ({ page }) => {
    await page.goto("/profile");
    await expect(loginHeading(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("/profile with a corrupted session goes to the login page", async ({ page }) => {
    await page.goto("/");
    await page.evaluate((key) => sessionStorage.setItem(key, "{not json"), SESSION_KEY);
    await page.goto("/profile");
    await expect(loginHeading(page)).toBeVisible();
  });

  test("a signed-in user keeps the session across a reload", async ({ page }) => {
    const email = await signIn(page, "reload");
    await page.reload();
    await expect(signedInHeading(page)).toBeVisible();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  });
});

test.describe("login page: POST /login", () => {
  test("202: shows where the link went, and lets the user use a different email", async ({ page }) => {
    const email = uniqueEmail("different");
    await requestLink(page, email);
    await expect(page.getByText(email)).toBeVisible();

    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(loginHeading(page)).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveValue(email);
  });

  test("an email typed in upper case with spaces still signs the user in", async ({ page }) => {
    const email = uniqueEmail("typed");
    const link = await requestLink(page, `  ${email.toUpperCase()}  `, email);

    await page.goto(inBrowser(link));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  });

  test("an empty email is refused by the browser", async ({ page }) => {
    const calls = countCalls(page, "/login");
    await page.goto("/");
    await sendButton(page).click();
    await expect(loginHeading(page)).toBeVisible();
    expect(
      await page
        .getByLabel("Email")
        .evaluate((input) => (input as unknown as { validity: { valueMissing: boolean } }).validity.valueMissing),
    ).toBe(true);
    expect(calls.count).toBe(0);
  });

  const failures: [string, number, string][] = [
    ["400", 400, "Invalid request"],
    ["429", 429, "Too many requests, please try again shortly"],
    ["500", 500, "Internal server error"],
  ];
  for (const [label, status, message] of failures) {
    test(`${label}: shows the API's message and lets the user retry`, async ({ page }) => {
      await page.goto("/");
      await fakeOnce(page, "/login", status, { message });
      await page.getByLabel("Email").fill(uniqueEmail(`fail${status}`));
      await sendButton(page).click();

      await expect(page.getByText(message)).toBeVisible();
      await expect(sendButton(page)).toBeEnabled();

      await sendButton(page).click(); // the real API this time
      await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    });
  }

  test("an answer that is not JSON shows a generic message", async ({ page }) => {
    await page.goto("/");
    await page.route("**/api/login", (route) => route.fulfill({ status: 502, body: "<html>Bad Gateway</html>" }), {
      times: 1,
    });
    await page.getByLabel("Email").fill(uniqueEmail("html"));
    await sendButton(page).click();
    await expect(page.getByText("Request failed with status 502")).toBeVisible();
  });

  test("a network failure is reported, not swallowed", async ({ page }) => {
    await page.goto("/");
    await page.route("**/api/login", (route) => route.abort("internetdisconnected"), { times: 1 });
    await page.getByLabel("Email").fill(uniqueEmail("offline"));
    await sendButton(page).click();
    await expect(page.locator(".error")).toBeVisible();
    await expect(sendButton(page)).toBeEnabled();
  });

  test("the button is disabled while the request is in flight", async ({ page }) => {
    await page.goto("/");
    const release = await holdNext(page, "**/api/login");
    await page.getByLabel("Email").fill(uniqueEmail("inflight"));
    await sendButton(page).click();

    await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
    release();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  });
});

test.describe("callback page: POST /auth/verify", () => {
  test("200: a link in the legacy query-string format still signs in", async ({ page }) => {
    const email = uniqueEmail("legacy");
    const link = await requestLink(page, email);

    await page.goto(`/auth/callback?${link.hash.slice(1)}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(email, { exact: true })).toBeVisible();
  });

  test("a double click verifies the link once", async ({ page }) => {
    const link = await requestLink(page, uniqueEmail("dblclick"));
    const calls = countCalls(page, "/auth/verify");

    await page.goto(inBrowser(link));
    await page.getByRole("button", { name: "Sign in" }).dblclick();
    await expect(signedInHeading(page)).toBeVisible();
    expect(calls.count).toBe(1);
  });

  test("shows a spinner while verifying", async ({ page }) => {
    const link = await requestLink(page, uniqueEmail("spinner"));
    const release = await holdNext(page, "**/api/auth/verify");

    await page.goto(inBrowser(link));
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("status", { name: "Loading" })).toBeVisible();
    release();
    await expect(signedInHeading(page)).toBeVisible();
  });

  test("401: an expired link is refused and keeps no session", async ({ page }) => {
    const email = uniqueEmail("expired");
    const link = await requestLink(page, email);
    await dynamo.send(
      new UpdateCommand({
        TableName: loadStack()?.tableName,
        Key: { pk: `EMAIL#${email}` },
        UpdateExpression: "SET expiresAt = :past",
        ExpressionAttributeValues: { ":past": Math.floor(Date.now() / 1000) - 1 },
      }),
    );

    await page.goto(inBrowser(link));
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText(BAD_LINK)).toBeVisible();
    expect(await storedSession(page)).toBeNull();
  });

  test("401: the link of another address is refused", async ({ page }) => {
    const link = await requestLink(page, uniqueEmail("owner"));
    const params = new URLSearchParams(link.hash.slice(1));
    params.set("email", uniqueEmail("intruder"));

    await page.goto(`/auth/callback#${params}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(BAD_LINK)).toBeVisible();
  });

  test("400: a malformed token is refused", async ({ page }) => {
    await page.goto("/auth/callback#email=someone%40example.com&token=not-hex");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(BAD_LINK)).toBeVisible();
  });

  for (const [label, status] of [
    ["429", 429],
    ["500", 500],
  ] as const) {
    test(`${label}: a failed verification leaves the link usable`, async ({ page, context }) => {
      const link = await requestLink(page, uniqueEmail(`verify${status}`));
      await fakeOnce(page, "/auth/verify", status, { message: "x" });

      await page.goto(inBrowser(link));
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByText(BAD_LINK)).toBeVisible();
      expect(await storedSession(page)).toBeNull();

      // The link was not used: it works in a new tab.
      const retry = await context.newPage();
      await retry.goto(inBrowser(link));
      await retry.getByRole("button", { name: "Sign in" }).click();
      await expect(signedInHeading(retry)).toBeVisible();
    });
  }

  for (const [label, fragment] of [
    ["no parameters", ""],
    ["only a token", `#token=${"a".repeat(64)}`],
    ["an empty email", `#email=&token=${"a".repeat(64)}`],
  ]) {
    test(`a link with ${label} is incomplete and calls nothing`, async ({ page }) => {
      const calls = countCalls(page, "/auth/verify");
      await page.goto(`/auth/callback${fragment}`);
      await expect(page.getByText(INCOMPLETE_LINK)).toBeVisible();
      expect(calls.count).toBe(0);
    });
  }
});

test.describe("profile page: GET /me, POST /auth/refresh, POST /logout", () => {
  test("200: shows the profile from /me and the ID token's claims", async ({ page }) => {
    const email = await signIn(page, "claims");
    const claims = JSON.parse((await page.locator("pre").textContent()) ?? "{}");

    expect(claims).toMatchObject({ email, email_verified: "true", token_use: "id" });
    await expect(page.getByText(`Hello, ${email}.`)).toBeVisible();
  });

  test("500 on /me: shows the error and keeps the session", async ({ page }) => {
    await signIn(page, "me500");
    await fakeOnce(page, "/me", 500, { message: "Internal server error" });
    await page.reload();

    await expect(page.getByText("Internal server error")).toBeVisible();
    expect(await storedSession(page)).not.toBeNull();
  });

  test("401 on /me: renews the session once, then retries with the new token", async ({ page }) => {
    await signIn(page, "me401");
    const refreshes = countCalls(page, "/auth/refresh");
    await fakeOnce(page, "/me", 401, { message: "Unauthorized" });
    await page.reload();

    await expect(page.getByText(/^Hello, /)).toBeVisible();
    expect(refreshes.count).toBe(1);
  });

  test("500 on /auth/refresh: shows the error and keeps the session", async ({ page }) => {
    await signIn(page, "refresh500");
    await page.evaluate((key) => {
      const stored = JSON.parse(sessionStorage.getItem(key) ?? "{}");
      sessionStorage.setItem(key, JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }));
    }, SESSION_KEY);
    await fakeOnce(page, "/auth/refresh", 500, { message: "Internal server error" });
    await page.reload();

    await expect(page.getByText("Internal server error")).toBeVisible();
    expect(await storedSession(page)).not.toBeNull();
  });

  test("a failed sign-out (500) still signs the user out locally", async ({ page }) => {
    await signIn(page, "logout500");
    await fakeOnce(page, "/logout", 500, { message: "Internal server error" });

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(loginHeading(page)).toBeVisible();
    expect(await storedSession(page)).toBeNull();
  });

  test("sign-out sends the refresh token in a JSON body", async ({ page }) => {
    await signIn(page, "logout-body");
    const refreshToken = await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key) ?? "{}").refreshToken as string,
      SESSION_KEY,
    );

    const logout = page.waitForRequest((request) => request.url().endsWith("/api/logout"));
    await page.getByRole("button", { name: "Sign out" }).click();
    const request = await logout;

    expect(request.method()).toBe("POST");
    expect(request.headers()["content-type"]).toBe("application/json");
    expect(request.postDataJSON()).toEqual({ refreshToken });
  });
});
