import { JwtVerifier } from "aws-jwt-verify";
import {
  FetchError,
  JwksNotAvailableInCacheError,
  JwksValidationError,
  JwkValidationError,
  JwtBaseError,
  NotSupportedError,
  ParameterValidationError,
} from "aws-jwt-verify/error";
import type { Fetcher } from "aws-jwt-verify/https";
import { SimpleJwksCache } from "aws-jwt-verify/jwk";
import type { JwtPayload } from "aws-jwt-verify/jwt-model";
import { requireEnv } from "./env.js";

/*
 * Verifies ID tokens (signature, issuer, audience, expiry, token_use) on top
 * of the Cognito authorizer, which LocalStack does not enforce. The issuer is
 * configured because it differs between AWS and LocalStack.
 */
let verifier: ReturnType<typeof createVerifier> | undefined;

const JWKS_TIMEOUT_MS = 3_000;

/** Plain http is allowed only for the local emulator. */
const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localstack.cloud");

/** JWKS fetcher with a timeout and http for local hosts (LocalStack serves http). */
export const jwksFetcher: Fetcher = {
  async fetch(uri) {
    const url = new URL(uri);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
      throw new FetchError(uri, "The JWKS must be served over https");
    }
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    } catch (error) {
      throw new FetchError(uri, String(error));
    }
    if (!response.ok) throw new FetchError(uri, `Status code is ${response.status}, expected 200`);
    return response.arrayBuffer();
  },
};

function createVerifier() {
  const issuer = requireEnv("ID_TOKEN_ISSUER");
  return JwtVerifier.create(
    {
      issuer,
      audience: requireEnv("USER_POOL_CLIENT_ID"),
      jwksUri: `${issuer}/.well-known/jwks.json`,
      customJwtCheck: ({ payload }) => {
        if (payload.token_use !== "id") throw new InvalidTokenUseError();
      },
    },
    { jwksCache: new SimpleJwksCache({ fetcher: jwksFetcher }) },
  );
}

/** One verifier per container, caching the JWKS. */
export function idTokenVerifier() {
  verifier ??= createVerifier();
  return verifier;
}

/** Test hook: drops the cached verifier. */
export function resetIdTokenVerifier(): void {
  verifier = undefined;
}

class InvalidTokenUseError extends Error {
  constructor() {
    super("Not an ID token");
    this.name = "InvalidTokenUseError";
  }
}

/** Missing, malformed, forged, expired or foreign token (HTTP 401). */
export class InvalidIdTokenError extends Error {
  constructor(readonly reason: string) {
    super("Unauthorized");
    this.name = "InvalidIdTokenError";
  }
}

/** Setup or JWKS failures: 5xx, since a 401 would end a valid session. */
const INFRASTRUCTURE_ERRORS = [
  FetchError,
  JwksNotAvailableInCacheError,
  JwksValidationError,
  JwkValidationError,
  NotSupportedError,
  ParameterValidationError,
];

/** Verifies `Authorization: <ID token>`, with or without `Bearer `. */
export async function verifyIdToken(authorization: string | undefined): Promise<JwtPayload> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new InvalidIdTokenError("missing token");

  try {
    return await idTokenVerifier().verify(token);
  } catch (error) {
    if (INFRASTRUCTURE_ERRORS.some((type) => error instanceof type)) throw error;
    if (error instanceof JwtBaseError || error instanceof InvalidTokenUseError) {
      throw new InvalidIdTokenError(error.name);
    }
    throw error;
  }
}
