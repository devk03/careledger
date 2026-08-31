import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

const loginErrors: Record<string, string> = {
  INVALID_CREDENTIALS: "That passphrase did not match. Check it and try again.",
  SETUP_REQUIRED: "The owner account has not been created yet. Open the private setup link first.",
  TRY_LATER: "There have been several unsuccessful attempts. Please wait a little before trying again.",
  ORIGIN_NOT_ALLOWED: "CareLedger blocked this request because it did not come from this installation.",
};

export function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setWorking(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(loginErrors[result.error ?? ""] ?? "CareLedger could not sign you in. Please try again.");
        return;
      }
      setPassword("");
      setAuthenticated(true);
    } catch {
      setError("CareLedger could not reach its private server. Check that it is running, then try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="auth-page">
      <header className="auth-topbar">
        <a className="wordmark" href="/" aria-label="CareLedger home">
          CareLedger
        </a>
        <p>
          <ShieldCheck aria-hidden="true" size={16} />
          Private installation
        </p>
      </header>
      <section className="auth-layout auth-layout-login">
        <div className="auth-heading">
          <div className="auth-mark" aria-hidden="true">
            <LockKeyhole size={21} />
          </div>
          <p className="auth-context">Welcome back</p>
          <h1>Return to the family workspace.</h1>
          <p className="auth-lede">
            CareLedger uses one local owner account. Your passphrase is checked by this installation.
          </p>
        </div>

        {authenticated ? (
          <div className="auth-form auth-signed-in" aria-live="polite">
            <ShieldCheck aria-hidden="true" size={22} />
            <h2>You’re signed in.</h2>
            <p>Your reviewed records and open questions are ready when you are.</p>
            <a className="primary-button" href="/">
              Open the workspace
              <ArrowRight aria-hidden="true" size={18} />
            </a>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="login-password">Owner passphrase</label>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                minLength={12}
                maxLength={128}
                autoFocus
                required
              />
              <small aria-hidden="true">&nbsp;</small>
            </div>
            <p className="auth-error" role="alert" aria-live="polite">
              {error}
            </p>
            <button className="primary-button auth-submit" type="submit" disabled={working}>
              {working ? "Checking the passphrase…" : "Sign in"}
              <ArrowRight aria-hidden="true" size={18} />
            </button>
            <a className="text-link auth-secondary-link" href="/recover">
              Use a saved recovery code
            </a>
          </form>
        )}
      </section>
    </main>
  );
}
