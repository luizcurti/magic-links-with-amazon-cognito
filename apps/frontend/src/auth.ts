import { ApiError, api } from "./api";
import { type Session, session } from "./session";

/** Renew this long before expiry, to absorb clock skew and request time. */
export const REFRESH_MARGIN_MS = 60_000;

const isFresh = (current: Session) => current.expiresAt - Date.now() >= REFRESH_MARGIN_MS;

let renewing: Promise<Session | undefined> | undefined;

/**
 * Gets new ID and access tokens with the refresh token. Concurrent callers
 * share one request. When the refresh token is revoked or expired, the
 * session is cleared and undefined is returned.
 */
export function renewSession(): Promise<Session | undefined> {
  renewing ??= renew().finally(() => {
    renewing = undefined;
  });
  return renewing;
}

async function renew(): Promise<Session | undefined> {
  const current = session.load();
  if (!current?.refreshToken) {
    session.clear();
    return undefined;
  }
  try {
    const renewed = await api.refresh(current.refreshToken);
    // Refresh-token rotation is off, so Cognito returns no new refresh token: keep ours.
    return session.save({ ...renewed, refreshToken: current.refreshToken });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      session.clear();
      return undefined;
    }
    throw error;
  }
}

/**
 * Calls the API with a valid ID token: renews it first when it is about to
 * expire, and once more if the API still answers 401. Resolves to undefined
 * when there is no session or it can no longer be renewed.
 */
export async function withSession<T>(call: (idToken: string) => Promise<T>): Promise<T | undefined> {
  let current = session.load();
  if (current && !isFresh(current)) current = await renewSession();
  if (!current) return undefined;

  try {
    return await call(current.idToken);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
    const renewed = await renewSession();
    return renewed ? call(renewed.idToken) : undefined;
  }
}
