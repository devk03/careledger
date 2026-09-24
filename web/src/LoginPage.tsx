import { AppHeader } from "./ui";
import { EditorialArt } from "./EditorialArt";
import { Button, Input, ButtonLink, Notice } from "./ui";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

const loginErrors: Record<string, string> = {
  INVALID_CREDENTIALS: "That passphrase did not match. Check it and try again.",
  SETUP_REQUIRED: "The owner account has not been created yet. Open the private setup link first.",
  TRY_LATER: "There have been several unsuccessful attempts. Please wait a little before trying again.",
  ORIGIN_NOT_ALLOWED: "adeno blocked this request because it did not come from this installation.",
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
        setError(loginErrors[result.error ?? ""] ?? "adeno could not sign you in. Please try again.");
        return;
      }
      setPassword("");
      setAuthenticated(true);
    } catch {
      setError("adeno could not reach its private server. Check that it is running, then try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="auth-page">
      <AppHeader className="auth-topbar" context={<> Private installation </>} />
      <section className="auth-layout auth-layout-login">
        <div className="auth-heading">
          <div className="auth-mark" aria-hidden="true">
            <LockKeyhole size={21} />
          </div>
          <p className="auth-context">Welcome back</p>
          <h1>Return to the family workspace.</h1>
          <p className="auth-lede">
            adeno uses one local owner account. Your passphrase is checked by this installation.
          </p>
          <EditorialArt className="auth-art" />
        </div>

        {authenticated ? (
          <div className="auth-form auth-signed-in" aria-live="polite">
            <ShieldCheck aria-hidden="true" size={22} />
            <h2>You’re signed in.</h2>
            <p>Your reviewed records and open questions are ready when you are.</p>
            <ButtonLink className="" href="/">
              Open the workspace
              <ArrowRight aria-hidden="true" size={18} />
            </ButtonLink>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="login-password">Owner passphrase</label>
              <Input
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
            <Notice className="auth-error" role="alert" aria-live="polite">
              {error}
            </Notice>
            <Button className="primary-button auth-submit" type="submit" loading={working}>
              {working ? "Checking the passphrase…" : "Sign in"}
              <ArrowRight aria-hidden="true" size={18} />
            </Button>
            <a className="text-link auth-secondary-link" href="/recover">
              Use a saved recovery code
            </a>
          </form>
        )}
      </section>
    </main>
  );
}
