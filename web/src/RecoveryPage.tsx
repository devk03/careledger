import { AppHeader } from "./ui";
import { EditorialArt } from "./EditorialArt";
import { Button, Input, ButtonLink, Notice } from "./ui";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";

const recoveryErrors: Record<string, string> = {
  INVALID_CREDENTIALS: "That recovery code could not be used. Check it carefully or try another unused code.",
  SETUP_REQUIRED: "The owner account has not been created yet. Open the private setup link first.",
  TRY_LATER: "There have been several unsuccessful attempts. Please wait a little before trying again.",
  ORIGIN_NOT_ALLOWED: "Adeno blocked this request because it did not come from this installation.",
  INVALID_INPUT: "Check the recovery code and new passphrase, then try again.",
};

export function RecoveryPage() {
  const [recoveryCode, setRecoveryCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [replacementCodes, setReplacementCodes] = useState<string[]>([]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("The two passphrases do not match yet.");
      return;
    }
    setWorking(true);
    try {
      const response = await fetch("/api/auth/recover", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recovery_code: recoveryCode, new_password: password }),
      });
      const result = (await response.json()) as { error?: string; recovery_codes?: string[] };
      if (!response.ok) {
        setError(
          recoveryErrors[result.error ?? ""] ??
            "Adeno could not recover the account. Please try again.",
        );
        return;
      }
      setRecoveryCode("");
      setPassword("");
      setConfirmation("");
      setReplacementCodes(result.recovery_codes ?? []);
    } catch {
      setError("Adeno could not reach its private server. Check that it is running, then try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main className="auth-page">
      <AppHeader className="auth-topbar" context={<> Private installation </>} />
      <section className="auth-layout">
        <div className="auth-heading">
          <div className="auth-mark" aria-hidden="true">
            <KeyRound size={21} />
          </div>
          <p className="auth-context">Account recovery</p>
          <h1>Use one saved recovery code.</h1>
          <p className="auth-lede">
            A successful recovery signs out every older session and replaces every previous code.
          </p>
          <EditorialArt scene="notes" className="auth-art" />
        </div>

        {replacementCodes.length ? (
          <div className="auth-form auth-recovered" aria-live="polite">
            <ShieldCheck aria-hidden="true" size={22} />
            <h2>Access has been recovered.</h2>
            <p>Save this replacement set. The older codes will no longer work.</p>
            <ol className="recovery-codes" aria-label="Replacement recovery codes">
              {replacementCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ol>
            <ButtonLink className="" href="/">
              I saved these codes
              <ArrowRight aria-hidden="true" size={18} />
            </ButtonLink>
          </div>
        ) : (
          <form className="auth-form" onSubmit={submit} noValidate>
            <div className="auth-field">
              <label htmlFor="recovery-code">Recovery code</label>
              <Input
                id="recovery-code"
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                autoComplete="one-time-code"
                aria-describedby="recovery-code-help"
                maxLength={32}
                required
              />
              <small id="recovery-code-help">Hyphens and letter case do not matter.</small>
            </div>
            <div className="auth-field">
              <label htmlFor="recovery-password">New owner passphrase</label>
              <Input
                id="recovery-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                aria-describedby="recovery-password-help"
                minLength={12}
                maxLength={128}
                required
              />
              <small id="recovery-password-help">Use at least 12 characters.</small>
            </div>
            <div className="auth-field">
              <label htmlFor="recovery-password-confirmation">Repeat the new passphrase</label>
              <Input
                id="recovery-password-confirmation"
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
              <small aria-hidden="true">&nbsp;</small>
            </div>
            <Notice className="auth-error" role="alert" aria-live="polite">
              {error}
            </Notice>
            <Button className="primary-button auth-submit" type="submit" loading={working}>
              {working ? "Recovering access…" : "Recover access"}
              <ArrowRight aria-hidden="true" size={18} />
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
