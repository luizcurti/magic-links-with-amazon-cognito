import type { AuthTokens } from "./api";

const KEY = "magic-links.session";

/*
 * Demo-grade storage. sessionStorage is cleared when the tab closes, but is
 * readable by any script on the page; a production app would keep tokens in
 * memory or in httpOnly cookies set by a backend-for-frontend.
 */
export const session = {
  save(tokens: AuthTokens): void {
    sessionStorage.setItem(KEY, JSON.stringify(tokens));
  },
  load(): AuthTokens | undefined {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as AuthTokens) : undefined;
    } catch {
      return undefined;
    }
  },
  clear(): void {
    sessionStorage.removeItem(KEY);
  },
};
