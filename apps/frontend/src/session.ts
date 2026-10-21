import type { AuthTokens } from "./api";

const KEY = "magic-links.session";

export interface Session extends AuthTokens {
  /** Epoch milliseconds: token expiry. */
  expiresAt: number;
}

// sessionStorage: cleared with the tab, but readable by any script on the page.
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
