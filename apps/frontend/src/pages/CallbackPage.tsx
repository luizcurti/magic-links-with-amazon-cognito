import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { navigate } from "../router";
import { session } from "../session";

/** Link parameters: from the fragment (`#email=…&token=…`), or the query string. */
function readLinkParams() {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  return { email: params.get("email"), token: params.get("token") };
}

type State =
  | { status: "confirm"; email: string; token: string }
  | { status: "verifying" }
  | { status: "error"; message: string };

/*
 * Nothing is verified until the user clicks "Sign in": mail scanners that open
 * links cannot burn them, and a link someone else sent cannot sign you in.
 */
export function CallbackPage() {
  // Read once: the effect below removes them from the URL.
  const [state, setState] = useState<State>(() => {
    const { email, token } = readLinkParams();
    return email && token
      ? { status: "confirm", email, token }
      : { status: "error", message: "This link is incomplete. Please request a new one." };
  });

  // Ignore a late answer once the page is left.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Remove the token from the address bar and history.
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
