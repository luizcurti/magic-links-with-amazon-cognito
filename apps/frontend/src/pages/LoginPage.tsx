import { useState, type FormEvent } from "react";
import { api } from "../api";

type State = { status: "idle" } | { status: "sending" } | { status: "sent"; email: string } | { status: "error"; message: string };

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setState({ status: "sending" });
    try {
      await api.requestMagicLink(email);
      setState({ status: "sent", email });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }

  if (state.status === "sent") {
    return (
      <>
        <h1>Check your inbox</h1>
        <p>
          We sent a sign-in link to <strong>{state.email}</strong>. It expires in 10 minutes and works only once.
        </p>
        <p className="hint">
          Running locally? The email was captured by LocalStack SES. Run <code>make emails</code> to see it.
        </p>
        <button className="secondary" onClick={() => setState({ status: "idle" })}>
          Use a different email
        </button>
      </>
    );
  }

  return (
    <>
      <h1>Sign in</h1>
      <p>No password needed. Enter your email and we will send you a magic link.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="luiz@example.com"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={state.status === "sending"}>
          {state.status === "sending" ? "Sending…" : "Send magic link"}
        </button>
      </form>
      {state.status === "error" && <p className="error">{state.message}</p>}
    </>
  );
}
