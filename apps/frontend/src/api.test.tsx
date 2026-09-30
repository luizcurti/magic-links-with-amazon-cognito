import { afterEach, describe, expect, it, vi } from "vitest";

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
