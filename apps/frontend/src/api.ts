export interface AuthTokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  tokenType: string;
}

export interface Profile {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Epoch seconds: when the user signed in with the magic link. */
  authTime: number;
  /** Epoch seconds: when the ID token expires. */
  expiresAt: number;
}

/**
 * Where the API lives. Locally the Vite dev server proxies /api to API
 * Gateway (same origin, no CORS). A build served from another origin sets
 * VITE_API_BASE_URL to the API Gateway URL; the API answers CORS preflights
 * for frontend_origin (see api-gateway.tf).
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(response.status, body.message ?? `Request failed with status ${response.status}`);
  }
  return body as T;
}

export const api = {
  requestMagicLink: (email: string) =>
    request<{ message: string }>("/login", { method: "POST", body: JSON.stringify({ email }) }),

  verifyMagicLink: (email: string, token: string) =>
    request<AuthTokens>("/auth/verify", { method: "POST", body: JSON.stringify({ email, token }) }),

  refresh: (refreshToken: string) =>
    request<AuthTokens>("/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) }),

  logout: (refreshToken: string) =>
    request<unknown>("/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }),

  me: (idToken: string) => request<Profile>("/me", { headers: { Authorization: idToken } }),
};
