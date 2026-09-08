import { AppHeader } from "./ui";
import { EditorialArt } from "./EditorialArt";
import { Button, Input, ButtonLink, Notice } from "./ui";
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

type SetupResult = {
  authenticated: boolean;
  recovery_codes: string[];
};

const setupErrors: Record<string, string> = {
  INVALID_SETUP: "This private setup link is invalid or has expired. Restart Adeno to issue a new link.",
  SETUP_ALREADY_COMPLETE: "Private setup is already complete. Use the sign-in page instead.",
  TRY_LATER: "There have been several unsuccessful attempts. Please wait a little before trying again.",
  ORIGIN_NOT_ALLOWED: "Adeno blocked this request because it did not come from this installation.",
  INVALID_INPUT: "Please check each field and try again.",
};

export function SetupPage() {
  const [token, setToken] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "",
  );
  const [displayName, setDisplayName] = useState("");
  const [householdName, setHouseholdName] = useState("My family");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);

  useEffect(() => {
    if (window.location.hash) {
      window.history.replaceState({}, "", "/setup");
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!token) {
      setError("Ask the workspace administrator for the private setup link.");
      return;
    }
    if (password !== confirmation) {
      setError("The two passphrases do not match yet.");
      return;
    }
    setWorking(true);
    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          display_name: displayName,
          household_name: householdName,
        }),
      });
      const result = (await response.json()) as SetupResult & { error?: string };
      if (!response.ok) {
        setError(setupErrors[result.error ?? ""] ?? "Adeno could not finish setup. Please try again.");
        return;
      }
      setToken("");
      setPassword("");
      setConfirmation("");
      setRecoveryCodes(result.recovery_codes);
    } catch {
      setError("Adeno could not reach its private server. Check that it is running, then try again.");
    } finally {
      setWorking(false);
    }
  }

  if (recoveryCodes.length) {
    return (
      <AuthShell>
        <div className="auth-success" aria-labelledby="recovery-title">
          <div className="auth-mark auth-mark-success" aria-hidden="true">
            <ShieldCheck size={22} />
          </div>
          <p className="auth-context">Private setup is complete</p>
          <h1 id="recovery-title">Save your recovery codes now.</h1>
          <p className="auth-lede">
            Keep these somewhere separate from Adeno. Each code is intended for one recovery
            and will not be shown again.
          </p>
          <ol className="recovery-codes" aria-label="One-time recovery codes">
            {recoveryCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ol>
          <p className="auth-helper">
            A password manager or a printed copy stored safely are both reasonable choices.
          </p>
          <ButtonLink className="" href="/">
            I saved these codes
            <ArrowRight aria-hidden="true" size={18} />
          </ButtonLink>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="auth-heading">
        <div className="auth-mark" aria-hidden="true">
          <LockKeyhole size={21} />
        </div>
        <p className="auth-context">First, protect the workspace</p>
        <h1>Set up your private Adeno.</h1>
        <p className="auth-lede">
          This creates the owner account for your family’s installation. There is no public signup.
        </p>
        <EditorialArt scene="notes" className="auth-art" />
      </div>

      <form className="auth-form" onSubmit={submit} noValidate>
        <div className="auth-field">
          <label htmlFor="setup-display-name">Your name</label>
          <Input
            id="setup-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            autoComplete="name"
            aria-describedby="setup-display-name-help"
            maxLength={120}
            required
          />
          <small id="setup-display-name-help">Shown only inside this family workspace.</small>
        </div>
        <div className="auth-field">
          <label htmlFor="setup-household-name">Workspace name</label>
          <Input
            id="setup-household-name"
            value={householdName}
            onChange={(event) => setHouseholdName(event.target.value)}
            aria-describedby="setup-household-name-help"
            maxLength={120}
            required
          />
          <small id="setup-household-name-help">
            For example, “My family.” Avoid a full legal name if you do not need it.
          </small>
        </div>
        <div className="auth-field">
          <label htmlFor="setup-password">Owner passphrase</label>
          <Input
            id="setup-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            aria-describedby="setup-password-help"
            minLength={12}
            maxLength={128}
            required
          />
          <small id="setup-password-help">
            Use at least 12 characters. A few unrelated words are easier to remember.
          </small>
        </div>
        <div className="auth-field">
          <label htmlFor="setup-password-confirmation">Repeat the passphrase</label>
          <Input
            id="setup-password-confirmation"
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
          <KeyRound aria-hidden="true" size={18} />
          {working ? "Protecting the workspace…" : "Create the owner account"}
        </Button>
      </form>
    </AuthShell>
  );
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <AppHeader className="auth-topbar" context={<> Private installation </>} />
      <section className="auth-layout">{children}</section>
    </main>
  );
}
