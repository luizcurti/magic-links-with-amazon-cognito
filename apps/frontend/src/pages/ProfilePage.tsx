import { useEffect, useState } from "react";
import { api, ApiError, type Profile } from "../api";
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
  const tokens = session.load();
  const [profile, setProfile] = useState<Profile>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!tokens) {
      navigate("/");
      return;
    }
    api
      .me(tokens.idToken)
      .then(setProfile)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          session.clear();
          navigate("/");
        } else {
          setError((err as Error).message);
        }
      });
  }, []);

  if (!tokens) return null;

  function signOut() {
    session.clear();
    navigate("/");
  }

  const claims = decodeJwtPayload(tokens.idToken);

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

      <button className="secondary" onClick={signOut}>
        Sign out
      </button>
    </>
  );
}
