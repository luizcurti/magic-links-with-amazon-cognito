/** Inputs and exact outputs (status, body, headers) of every route on LocalStack. */

import { describe, expect, it } from "vitest";
import { isLocalStackUp, linkParams, loadStack, post, uniqueEmail, waitForMagicLink } from "./stack.js";

const stack = loadStack();
const ready = stack !== undefined && (await isLocalStackUp());
const apiUrl = stack?.apiUrl ?? "";

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

async function call(
  path: string,
  { method = "POST", headers = { "Content-Type": "application/json" }, body }: RequestInit = {},
): Promise<RawResponse> {
  const response = await fetch(`${apiUrl}${path}`, { method, headers, body });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

const send = (path: string, body: unknown) => call(path, { body: JSON.stringify(body) });

/** Every response a Lambda produces carries the same headers. */
function expectResponse(response: RawResponse, status: number, body?: unknown) {
  expect({ status: response.status, body: response.json }).toEqual({ status, body });
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
}

const invalid = (...errors: [field: string, message: string][]) => ({
  message: "Invalid request",
  errors: errors.map(([field, message]) => ({ field, message })),
});
const notAnObject = (received: string) => invalid(["", `Invalid input: expected object, received ${received}`]);

const GENERIC_LOGIN = { message: "If the email address is valid, a magic link is on its way." };
const UNSUPPORTED_MEDIA = { message: "Content-Type must be application/json" };
const BAD_LINK = { message: "Invalid or expired magic link" };
const SESSION_OVER = { message: "Session expired or revoked" };

const JSON_ROUTES = [
  ["/login", { email: "contract@example.com" }],
  ["/auth/verify", { email: "contract@example.com", token: "0".repeat(64) }],
  ["/auth/refresh", { refreshToken: "x" }],
  ["/logout", { refreshToken: "x" }],
] as const;

async function signIn(label: string) {
  const email = uniqueEmail(label);
  const sentAfter = new Date(Date.now() - 1_000);
  await post(`${apiUrl}/login`, { email });
  const token = linkParams(await waitForMagicLink(email, sentAfter)).get("token") ?? "";
  const response = await send("/auth/verify", { email, token });
  return { email, response, tokens: response.json as Record<string, string | number> };
}

const jwtClaims = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());

describe.runIf(ready)("route contract (LocalStack)", { timeout: 60_000 }, () => {
  describe.each(JSON_ROUTES)("POST %s: malformed requests", (path, valid) => {
    it.each([
      ["no Content-Type", {}],
      ["text/plain", { "Content-Type": "text/plain" }],
      ["a form", { "Content-Type": "application/x-www-form-urlencoded" }],
      ["a JSON look-alike", { "Content-Type": "application/jsonp" }],
    ])("415 for %s", async (_label, headers) => {
      expectResponse(await call(path, { headers, body: JSON.stringify(valid) }), 415, UNSUPPORTED_MEDIA);
    });

    it.each([
      ["an empty body", "", { message: "Request body is required" }],
      ["invalid JSON", "{nope", { message: "Request body must be valid JSON" }],
      ["JSON null", "null", notAnObject("null")],
      ["a JSON array", "[]", notAnObject("array")],
      ["a JSON string", '"x"', notAnObject("string")],
      ["a JSON number", "42", notAnObject("number")],
    ])("400 for %s", async (_label, body, expected) => {
      expectResponse(await call(path, { body }), 400, expected);
    });

    it("accepts a JSON Content-Type with a charset", async () => {
      const response = await call(path, {
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(valid),
      });
      expect([200, 202, 204, 401]).toContain(response.status);
    });
  });

  describe("POST /login", () => {
    it("202 with the generic message, and the email arrives", async () => {
      const email = uniqueEmail("contract-login");
      const sentAfter = new Date(Date.now() - 1_000);

      expectResponse(await send("/login", { email, extra: "ignored" }), 202, GENERIC_LOGIN);
      await expect(waitForMagicLink(email, sentAfter)).resolves.toBeInstanceOf(URL);
    });

    it("202 for a 254-character email (the limit)", async () => {
      const email = `${"a".repeat(254 - "@example.com".length)}@example.com`;
      expectResponse(await send("/login", { email }), 202, GENERIC_LOGIN);
    });

    it.each([
      ["missing", {}, "email is required"],
      ["null", { email: null }, "email is required"],
      ["a number", { email: 42 }, "email is required"],
      ["empty", { email: "" }, "email must be a valid email address"],
      ["invalid", { email: "nope" }, "email must be a valid email address"],
      ["a header injection", { email: "a@example.com\r\nBcc: b@example.com" }, "email must be a valid email address"],
      ["255 characters long", { email: `${"a".repeat(255 - "@example.com".length)}@example.com` }, "email is too long"],
    ])("400 when email is %s", async (_label, body, message) => {
      expectResponse(await send("/login", body), 400, invalid(["email", message]));
    });
  });

  describe("POST /auth/verify", () => {
    it("200 with exactly the documented fields", async () => {
      const { response, tokens } = await signIn("contract-verify");

      expectResponse(response, 200, {
        idToken: expect.any(String),
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: 900,
        tokenType: "Bearer",
      });
      expect(jwtClaims(String(tokens.idToken)).token_use).toBe("id");
      expect(jwtClaims(String(tokens.accessToken)).token_use).toBe("access");
    });

    it.each([
      [
        "{}",
        {},
        [
          ["email", "email is required"],
          ["token", "token is required"],
        ],
      ],
      ["no token", { email: "a@example.com" }, [["token", "token is required"]]],
      ["no email", { token: "0".repeat(64) }, [["email", "email is required"]]],
      [
        "an invalid email",
        { email: "nope", token: "0".repeat(64) },
        [["email", "email must be a valid email address"]],
      ],
      ["a numeric token", { email: "a@example.com", token: 1 }, [["token", "token is required"]]],
      [
        "a 63-character token",
        { email: "a@example.com", token: "0".repeat(63) },
        [["token", "token has an invalid format"]],
      ],
      [
        "a 65-character token",
        { email: "a@example.com", token: "0".repeat(65) },
        [["token", "token has an invalid format"]],
      ],
      [
        "an upper-case token",
        { email: "a@example.com", token: "A".repeat(64) },
        [["token", "token has an invalid format"]],
      ],
      [
        "a non-hex token",
        { email: "a@example.com", token: "g".repeat(64) },
        [["token", "token has an invalid format"]],
      ],
    ] as [string, unknown, [string, string][]][])("400 for %s", async (_label, body, errors) => {
      expectResponse(await send("/auth/verify", body), 400, invalid(...errors));
    });

    it("401 with the same message for a wrong token and an unknown email", async () => {
      expectResponse(await send("/auth/verify", { email: uniqueEmail("ghost"), token: "0".repeat(64) }), 401, BAD_LINK);
    });
  });

  describe("GET /me", () => {
    it("200 with exactly the documented fields, consistent with the ID token", async () => {
      const { email, tokens } = await signIn("contract-me");
      const response = await call("/me", { method: "GET", headers: { Authorization: String(tokens.idToken) } });
      const claims = jwtClaims(String(tokens.idToken));

      expectResponse(response, 200, {
        sub: claims.sub,
        email,
        emailVerified: true,
        authTime: Number(claims.auth_time),
        expiresAt: claims.exp,
      });
    });

    it.each([
      ["no Authorization header", {}],
      ["garbage", { Authorization: "garbage" }],
      // LocalStack's authorizer answers 500 for some malformed signatures (e.g. empty).
      ["a JWT with alg=none", { Authorization: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.invalid" }],
    ])("401 for %s", async (_label, headers) => {
      expect((await call("/me", { method: "GET", headers })).status).toBe(401);
    });
  });

  describe("POST /auth/refresh", () => {
    it("200 with new ID and access tokens and no refresh token", async () => {
      const { tokens } = await signIn("contract-refresh");
      const response = await send("/auth/refresh", { refreshToken: tokens.refreshToken });

      expectResponse(response, 200, {
        idToken: expect.any(String),
        accessToken: expect.any(String),
        expiresIn: 900,
        tokenType: "Bearer",
      });
      expect(jwtClaims((response.json as { idToken: string }).idToken).sub).toBe(jwtClaims(String(tokens.idToken)).sub);
    });

    it.each([
      ["a token Cognito never issued", "forged.refresh.token"],
      ["an ID token instead of a refresh token", "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig"],
    ])("401 for %s", async (_label, refreshToken) => {
      expectResponse(await send("/auth/refresh", { refreshToken }), 401, SESSION_OVER);
    });
  });

  describe("POST /logout", () => {
    it("204 with an empty body for a live token", async () => {
      const { tokens } = await signIn("contract-logout");
      const response = await send("/logout", { refreshToken: tokens.refreshToken });
      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    });

    it("204 for a token Cognito never issued (no oracle on token validity)", async () => {
      expect((await send("/logout", { refreshToken: "forged.refresh.token" })).status).toBe(204);
    });
  });

  describe.each(["/auth/refresh", "/logout"])("POST %s: refreshToken field", (path) => {
    it.each([
      ["missing", {}, "refreshToken is required"],
      ["null", { refreshToken: null }, "refreshToken is required"],
      ["empty", { refreshToken: "" }, "refreshToken is required"],
      ["a number", { refreshToken: 42 }, "refreshToken is required"],
      ["8193 characters long", { refreshToken: "x".repeat(8193) }, "refreshToken is too long"],
    ])("400 when refreshToken is %s", async (_label, body, message) => {
      expectResponse(await send(path, body), 400, invalid(["refreshToken", message]));
    });
  });

  describe("methods and routes that do not exist", () => {
    it.each([
      ["GET", "/login"],
      ["PUT", "/login"],
      ["DELETE", "/login"],
      ["GET", "/auth/verify"],
      ["GET", "/auth/refresh"],
      ["GET", "/logout"],
      ["POST", "/me"],
      ["DELETE", "/me"],
      ["POST", "/admin"],
      ["GET", "/"],
    ])("%s %s -> 403", async (method, path) => {
      expect((await call(path, { method, body: method === "GET" ? undefined : "{}" })).status).toBe(403);
    });
  });
});
