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
 * API Gateway's Cognito authorizer already checks the ID token, but the Lambda
 * checks it again (signature against the pool's JWKS, issuer, audience,
 * expiry, token_use): the claims it returns are then proven here, not taken
 * on trust from the request context, and a misconfigured or emulated
 * authorizer (LocalStack's accepts forged tokens) cannot let one through.
 *
 * The issuer is configured rather than derived from the pool ID because it
 * differs between AWS (https://cognito-idp.<region>.amazonaws.com/<pool>) and
 * LocalStack; the JWKS always lives at <issuer>/.well-known/jwks.json.
 */
let verifier: ReturnType<typeof createVerifier> | undefined;

const JWKS_TIMEOUT_MS = 3_000;

/** Plain http is only acceptable on the local emulator; anywhere else the key set could be swapped in transit. */
const isLocalHost = (hostname: string) =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".localstack.cloud");

/**
 * The library's own fetcher only speaks https, and LocalStack serves the JWKS
 * over http. This one uses Node's fetch, allows http for local hosts only,
 * times out, and reports every failure as the library's FetchError.
 */
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

/** One verifier per container: it caches the JWKS across invocations. */
export function idTokenVerifier() {
  verifier ??= createVerifier();
  return verifier;
}

/** Test hook: forget the verifier, e.g. after changing its configuration. */
export function resetIdTokenVerifier(): void {
  verifier = undefined;
}

class InvalidTokenUseError extends Error {
  constructor() {
    super("Not an ID token");
    this.name = "InvalidTokenUseError";
  }
}

/** Thrown for a missing, malformed, forged, expired or foreign token. Mapped to HTTP 401. */
export class InvalidIdTokenError extends Error {
  constructor(readonly reason: string) {
    super("Unauthorized");
    this.name = "InvalidIdTokenError";
  }
}

/**
 * Failures of our own setup or of the JWKS endpoint, not of the token. They
 * must surface as 5xx: answering 401 would make the frontend drop a perfectly
 * valid session.
 */
const INFRASTRUCTURE_ERRORS = [
  FetchError,
  JwksNotAvailableInCacheError,
  JwksValidationError,
  JwkValidationError,
  NotSupportedError,
  ParameterValidationError,
];

/** Verifies `Authorization: <ID token>` (a `Bearer ` prefix is accepted too). */
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
