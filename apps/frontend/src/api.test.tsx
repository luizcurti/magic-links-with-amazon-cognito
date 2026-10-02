import { afterEach, describe, expect, it, vi } from "vitest";

type Api = typeof import("./api").api;

async function loadApi() {
  vi.resetModules();
  return (await import("./api")).api;
}

describe("API base URL", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("goes through the Vite /api proxy by default (same origin)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sub: "s" }));
    vi.stubGlobal("fetch", fetchMock);

    await (await loadApi()).me("id-token");

    expect(fetchMock).toHaveBeenCalledWith("/api/me", expect.anything());
  });

  it("calls the API directly when the build is served from another origin", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/prod/");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ sub: "s" }));
    vi.stubGlobal("fetch", fetchMock);

    await (await loadApi()).me("id-token");

    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/prod/me", expect.anything());
  });
});

describe("API client: what each call sends and what it returns", () => {
  const TOKENS = { idToken: "id", accessToken: "access", refreshToken: "r", expiresIn: 900, tokenType: "Bearer" };

  const calls = [
    [
      "requestMagicLink",
      (a: Api) => a.requestMagicLink("luiz@example.com"),
      "/api/login",
      "POST",
      { email: "luiz@example.com" },
      undefined,
    ],
    [
      "verifyMagicLink",
      (a: Api) => a.verifyMagicLink("luiz@example.com", "ab"),
      "/api/auth/verify",
      "POST",
      { email: "luiz@example.com", token: "ab" },
      undefined,
    ],
    ["refresh", (a: Api) => a.refresh("r"), "/api/auth/refresh", "POST", { refreshToken: "r" }, undefined],
    ["logout", (a: Api) => a.logout("r"), "/api/logout", "POST", { refreshToken: "r" }, undefined],
    ["me", (a: Api) => a.me("id-token"), "/api/me", undefined, undefined, "id-token"],
  ] as const;

  it.each(calls)(
    "%s sends a JSON request to the right route",
    async (_name, call, url, method, body, authorization) => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({}));
      vi.stubGlobal("fetch", fetchMock);

      await call(await loadApi());

      const [calledUrl, init] = fetchMock.mock.calls[0] ?? [];
      expect(calledUrl).toBe(url);
      expect(init.method).toBe(method);
      expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(body);
      expect(init.headers).toEqual({
        "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      });
    },
  );

  it.each([
    [
      "requestMagicLink",
      (a: Api) => a.requestMagicLink("x"),
      202,
      { message: "If the email address is valid, a magic link is on its way." },
    ],
    ["verifyMagicLink", (a: Api) => a.verifyMagicLink("x", "y"), 200, TOKENS],
    ["refresh", (a: Api) => a.refresh("r"), 200, { ...TOKENS, refreshToken: undefined }],
    ["me", (a: Api) => a.me("t"), 200, { sub: "s", email: "e", emailVerified: true, authTime: 1, expiresAt: 2 }],
  ] as const)("%s resolves to the response body", async (_name, call, status, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
    expect(await call(await loadApi())).toEqual(JSON.parse(JSON.stringify(body)));
  });

  it("logout resolves on 204 No Content (empty body)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    expect(await (await loadApi()).logout("r")).toEqual({});
  });

  it.each([
    [
      400,
      { message: "Invalid request", errors: [{ field: "email", message: "email is required" }] },
      "Invalid request",
    ],
    [401, { message: "Invalid or expired magic link" }, "Invalid or expired magic link"],
    [415, { message: "Content-Type must be application/json" }, "Content-Type must be application/json"],
    [429, { message: "Too many requests, please try again shortly" }, "Too many requests, please try again shortly"],
    [500, { message: "Internal server error" }, "Internal server error"],
  ])("rejects a %i with an ApiError carrying the status and the API's message", async (status, body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
    const error = await (await loadApi()).requestMagicLink("x").catch((e: unknown) => e);
    expect(error).toMatchObject({ status, message });
  });

  it.each([
    ["an HTML error page (e.g. a proxy's 502)", new Response("<html>Bad Gateway</html>", { status: 502 })],
    ["an empty 403 from API Gateway", new Response(null, { status: 403 })],
    ["a JSON error without a message", Response.json({ error: "x" }, { status: 503 })],
  ])("rejects %s with a generic message", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await (await loadApi()).me("t").catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: response.status,
      message: `Request failed with status ${response.status}`,
    });
  });

  it("propagates a network failure as is", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect((await loadApi()).me("t")).rejects.toThrow("Failed to fetch");
  });
});
