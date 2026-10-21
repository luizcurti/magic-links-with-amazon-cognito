import { useEffect, useState } from "react";
import { ApiError, api, type Profile } from "../api";
import { withSession } from "../auth";
import { navigate } from "../router";
import { session } from "../session";

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  try {
    const payload = jwt.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export function ProfilePage() {
  const [signedIn] = useState(() => session.load() !== undefined);
  const [idToken, setIdToken] = useState(() => session.load()?.idToken ?? "");
  const [profile, setProfile] = useState<Profile>();
  const [error, setError] = useState<string>();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (!signedIn) {
      navigate("/");
      return;
    }
    // Show the claims of the token actually used (it may have been renewed).
    let usedToken = "";
    withSession((token) => {
      usedToken = token;
      return api.me(token);
    })
      .then((me) => {
        if (!me) return navigate("/");
        setProfile(me);
        setIdToken(usedToken);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          session.clear();
          navigate("/");
        } else {
          setError((err as Error).message);
        }
      });
  }, [signedIn]);

  if (!signedIn) return null;

  async function signOut() {
    setSigningOut(true);
    // Revoke first; the local session is dropped even if that fails.
    const refreshToken = session.load()?.refreshToken;
    if (refreshToken) await api.logout(refreshToken).catch(() => undefined);
    session.clear();
    navigate("/");
  }

  const claims = decodeJwtPayload(idToken);

  return (
    <>
      <h1>You are signed in</h1>
      {profile ? (
        <p>
          Hello, <strong>{profile.email}</strong>. This data came from <code>GET /me</code>, a route protected by the
          API Gateway Cognito authorizer.
        </p>
      ) : error ? (
        <p className="error">{error}</p>
      ) : (
        <p>Loading profile…</p>
      )}

      <h2>ID token claims</h2>
      <pre>{JSON.stringify(claims, null, 2)}</pre>

      <button type="button" className="secondary" onClick={signOut} disabled={signingOut}>
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </>
  );
}
