import { useEffect, useState } from "react";
import { type AuthTokens, api } from "../api";
import { navigate } from "../router";
import { session } from "../session";

/*
 * Magic-link tokens are single-use, so the exchange must happen exactly once
 * per token — even when React StrictMode runs effects twice in development.
 */
const inFlight = new Map<string, Promise<AuthTokens>>();

function verifyOnce(email: string, token: string): Promise<AuthTokens> {
  let promise = inFlight.get(token);
  if (!promise) {
    promise = api.verifyMagicLink(email, token);
    inFlight.set(token, promise);
  }
  return promise;
}

function readLinkParams() {
  const params = new URLSearchParams(window.location.search);
  return { email: params.get("email"), token: params.get("token") };
}

export function CallbackPage() {
  // Read once into state: the effect below removes them from the URL.
  const [{ email, token }] = useState(readLinkParams);
  const [error, setError] = useState<string>();

  useEffect(() => {
    // Drop the token from the address bar and browser history, whatever the outcome.
    window.history.replaceState({}, "", "/auth/callback");

    if (!email || !token) {
      setError("This link is incomplete. Please request a new one.");
      return;
    }

    let cancelled = false;
    verifyOnce(email, token)
      .then((tokens) => {
        if (cancelled) return;
        session.save(tokens);
        navigate("/profile");
      })
      .catch(() => {
        if (!cancelled) setError("This link is invalid, expired or has already been used.");
      });

    return () => {
      cancelled = true;
    };
  }, [email, token]);

  if (error) {
    return (
      <>
        <h1>Sign-in failed</h1>
        <p className="error">{error}</p>
        <button type="button" onClick={() => navigate("/")}>
          Request a new link
        </button>
      </>
    );
  }

  return (
    <>
      <h1>Signing you in…</h1>
      <p>Verifying your magic link with Cognito.</p>
      <div className="spinner" role="status" aria-label="Loading" />
    </>
  );
}
