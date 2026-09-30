import type { AuthTokens } from "./api";

const KEY = "magic-links.session";

export interface Session extends AuthTokens {
  /** Epoch milliseconds when the ID and access tokens expire. */
  expiresAt: number;
}

/*
 * Demo-grade storage. sessionStorage is cleared when the tab closes, but is
 * readable by any script on the page; a production app would keep tokens in
 * memory or in httpOnly cookies set by a backend-for-frontend.
 */
export const session = {
  save(tokens: AuthTokens): Session {
    const stored = { ...tokens, expiresAt: Date.now() + tokens.expiresIn * 1000 };
    sessionStorage.setItem(KEY, JSON.stringify(stored));
    return stored;
  },
  load(): Session | undefined {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Session) : undefined;
    } catch {
      return undefined;
    }
  },
  clear(): void {
    sessionStorage.removeItem(KEY);
  },
};
