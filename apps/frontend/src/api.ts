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
  authTime: string;
  expiresAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
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

  me: (idToken: string) => request<Profile>("/me", { headers: { Authorization: idToken } }),
};
