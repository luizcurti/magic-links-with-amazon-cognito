import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { navigate } from "../router";
import { session } from "../session";

/**
 * The link carries its parameters in the fragment (`#email=…&token=…`), which
 * the browser never sends to a server. The query string is still read so a
 * link issued before that change keeps working until it expires.
 */
function readLinkParams() {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  return { email: params.get("email"), token: params.get("token") };
}

type State =
  | { status: "confirm"; email: string; token: string }
  | { status: "verifying" }
  | { status: "error"; message: string };

/*
 * Nothing is verified until the user clicks. Mail security scanners (Outlook
 * Safe Links and the like) open every link in an email, some of them running
 * JavaScript; verifying on page load would let them burn the single-use link
 * before the user ever sees it. The explicit "Sign in as …" step also stops a
 * link someone else sent from silently signing the user into their account.
 */
export function CallbackPage() {
  // Read once into state: the effect below removes them from the URL.
  const [state, setState] = useState<State>(() => {
    const { email, token } = readLinkParams();
    return email && token
      ? { status: "confirm", email, token }
      : { status: "error", message: "This link is incomplete. Please request a new one." };
  });

  // A late answer must not navigate or save a session once the page was left.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Drop the token from the address bar and browser history, whatever the outcome.
    window.history.replaceState({}, "", "/auth/callback");
    return () => {
      mounted.current = false;
    };
  }, []);

  async function signIn(email: string, token: string) {
    setState({ status: "verifying" });
    try {
      const tokens = await api.verifyMagicLink(email, token);
      if (!mounted.current) return;
      session.save(tokens);
      navigate("/profile");
    } catch {
      if (mounted.current)
        setState({ status: "error", message: "This link is invalid, expired or has already been used." });
    }
  }

  if (state.status === "error") {
    return (
      <>
        <h1>Sign-in failed</h1>
        <p className="error">{state.message}</p>
        <button type="button" onClick={() => navigate("/")}>
          Request a new link
        </button>
      </>
    );
  }

  if (state.status === "verifying") {
    return (
      <>
        <h1>Signing you in…</h1>
        <p>Verifying your magic link with Cognito.</p>
        <div className="spinner" role="status" aria-label="Loading" />
      </>
    );
  }

  return (
    <>
      <h1>Confirm sign-in</h1>
      <p>
        Sign in as <strong>{state.email}</strong>?
      </p>
      <p className="hint">If you did not request this link, close this page: nothing happens until you confirm.</p>
      <button type="button" onClick={() => signIn(state.email, state.token)}>
        Sign in
      </button>
    </>
  );
}
