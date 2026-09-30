import { FetchError } from "aws-jwt-verify/error";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jwksFetcher } from "../../apps/api/src/lib/id-token.js";

describe("JWKS fetcher", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fetches the key set over https", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"keys":[]}'));
    vi.stubGlobal("fetch", fetchMock);

    const body = await jwksFetcher.fetch("https://cognito-idp.us-east-1.amazonaws.com/pool/.well-known/jwks.json");

    expect(new TextDecoder().decode(body)).toBe('{"keys":[]}');
    expect(fetchMock.mock.calls[0]![1]).toHaveProperty("signal");
  });

  it.each([
    "http://localhost:4566/pool/.well-known/jwks.json",
    "http://127.0.0.1:4566/pool/.well-known/jwks.json",
    "http://localhost.localstack.cloud:4566/pool/.well-known/jwks.json",
  ])("allows plain http for the local emulator (%s)", async (uri) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await expect(jwksFetcher.fetch(uri)).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it.each([
    "http://cognito-idp.us-east-1.amazonaws.com/pool/.well-known/jwks.json",
    "http://evil.localstack.cloud.example.com/pool/.well-known/jwks.json",
    "ftp://localhost/jwks.json",
  ])("refuses a key set that could be swapped in transit (%s)", async (uri) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(jwksFetcher.fetch(uri)).rejects.toBeInstanceOf(FetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports an HTTP error status as a FetchError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 503 })));
    await expect(jwksFetcher.fetch("https://issuer.example.com/jwks.json")).rejects.toBeInstanceOf(FetchError);
  });

  it("reports a network failure or timeout as a FetchError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(jwksFetcher.fetch("https://issuer.example.com/jwks.json")).rejects.toBeInstanceOf(FetchError);
  });
});
