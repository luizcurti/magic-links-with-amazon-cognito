import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { REFRESH_MARGIN_MS, renewSession, withSession } from "./auth";
import { session } from "./session";

const TOKENS = {
  idToken: "id-1",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresIn: 900,
  tokenType: "Bearer",
};
const RENEWED = { idToken: "id-2", accessToken: "access-2", expiresIn: 900, tokenType: "Bearer" };

/** Stores a session that expires `msLeft` from now. */
function storeSession(msLeft: number, tokens: object = TOKENS) {
  sessionStorage.setItem("magic-links.session", JSON.stringify({ ...tokens, expiresAt: Date.now() + msLeft }));
}

function routeFetch(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof routeFetch>, url: string) =>
  fetchMock.mock.calls.filter(([called]) => called === url).length;

describe("withSession", () => {
  beforeEach(() => sessionStorage.clear());

  it("uses a fresh ID token as is", async () => {
    storeSession(10 * 60_000);
    const fetchMock = routeFetch({});
    const call = vi.fn().mockResolvedValue("ok");

    await expect(withSession(call)).resolves.toBe("ok");
    expect(call).toHaveBeenCalledWith("id-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews a token about to expire before calling, keeping the refresh token", async () => {
    storeSession(REFRESH_MARGIN_MS - 1);
    const fetchMock = routeFetch({ "/api/auth/refresh": () => Response.json(RENEWED) });
    const call = vi.fn().mockResolvedValue("ok");

    await withSession(call);

    expect(call).toHaveBeenCalledWith("id-2");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({ body: JSON.stringify({ refreshToken: "refresh-1" }) }),
    );
    expect(session.load()).toMatchObject({ idToken: "id-2", refreshToken: "refresh-1" });
    expect(session.load()?.expiresAt).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("renews a session stored before expiry times were recorded", async () => {
    sessionStorage.setItem("magic-links.session", JSON.stringify(TOKENS));
    routeFetch({ "/api/auth/refresh": () => Response.json(RENEWED) });
    const call = vi.fn().mockResolvedValue("ok");

    await withSession(call);

    expect(call).toHaveBeenCalledWith("id-2");
  });

  it("renews once and retries when the API rejects a token that looked valid", async () => {
    storeSession(10 * 60_000);
    routeFetch({ "/api/auth/refresh": () => Response.json(RENEWED) });
    const call = vi.fn().mockRejectedValueOnce(new ApiError(401, "Unauthorized")).mockResolvedValueOnce("ok");

    await expect(withSession(call)).resolves.toBe("ok");
    expect(call.mock.calls).toEqual([["id-1"], ["id-2"]]);
  });

  it("ends the session when the refresh token was revoked", async () => {
    storeSession(0);
    routeFetch({
      "/api/auth/refresh": () => Response.json({ message: "Session expired or revoked" }, { status: 401 }),
    });
    const call = vi.fn();

    await expect(withSession(call)).resolves.toBeUndefined();
    expect(call).not.toHaveBeenCalled();
    expect(session.load()).toBeUndefined();
  });

  it("ends the session when a 401 persists and the refresh is refused", async () => {
    storeSession(10 * 60_000);
    routeFetch({ "/api/auth/refresh": () => Response.json({}, { status: 401 }) });
    const call = vi.fn().mockRejectedValue(new ApiError(401, "Unauthorized"));

    await expect(withSession(call)).resolves.toBeUndefined();
    expect(session.load()).toBeUndefined();
  });

  it("ends a session that has no refresh token once it expires", async () => {
    storeSession(0, { ...TOKENS, refreshToken: undefined });
    const fetchMock = routeFetch({});

    await expect(withSession(vi.fn())).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(session.load()).toBeUndefined();
  });

  it("resolves to undefined without a session", async () => {
    await expect(withSession(vi.fn())).resolves.toBeUndefined();
  });

  it("keeps the session and surfaces other errors", async () => {
    storeSession(0);
    routeFetch({ "/api/auth/refresh": () => Response.json({ message: "Too many requests" }, { status: 429 }) });

    await expect(withSession(vi.fn())).rejects.toMatchObject({ status: 429 });
    expect(session.load()).toBeDefined();
  });

  it("propagates non-401 errors from the call without renewing", async () => {
    storeSession(10 * 60_000);
    const fetchMock = routeFetch({});

    await expect(withSession(vi.fn().mockRejectedValue(new ApiError(502, "Bad gateway")))).rejects.toThrow(
      "Bad gateway",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("renewSession", () => {
  beforeEach(() => sessionStorage.clear());

  it("shares one refresh request between concurrent callers", async () => {
    storeSession(0);
    const fetchMock = routeFetch({ "/api/auth/refresh": () => Response.json(RENEWED) });

    const [first, second] = await Promise.all([renewSession(), renewSession()]);

    expect(callsTo(fetchMock, "/api/auth/refresh")).toBe(1);
    expect(first).toEqual(second);
  });
});
