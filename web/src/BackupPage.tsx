import { ArrowLeft, Download, KeyRound, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

type Session = {
  authenticated: boolean;
  csrf_token: string | null;
  user: { display_name: string; role: string } | null;
};

export function BackupPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [accountPassword, setAccountPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { credentials: "same-origin" })
      .then((response) => response.json())
      .then((value: Session) => {
        if (!cancelled) setSession(value);
      })
      .catch(() => {
        if (!cancelled) setError("Adeno could not verify the owner session.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function exportBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.csrf_token || passphrase !== confirmation) return;
    setWorking(true);
    setError("");
    setComplete(false);
    try {
      const response = await fetch("/api/backups/export", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf_token,
        },
        body: JSON.stringify({
          account_password: accountPassword,
          backup_passphrase: passphrase,
        }),
      });
      if (!response.ok) {
        const result = (await response.json()) as { error?: string };
        setError(
          result.error === "INVALID_CREDENTIALS"
            ? "The account password was not correct. No backup was created."
            : "Adeno could not create a verified backup.",
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "careledger-backup.clb";
      link.click();
      URL.revokeObjectURL(url);
      setAccountPassword("");
      setPassphrase("");
      setConfirmation("");
      setComplete(true);
    } catch {
      setError("Adeno could not create the download. No live records were changed.");
    } finally {
      setWorking(false);
    }
  }

  if (session && (!session.authenticated || session.user?.role !== "owner")) {
    return (
      <main className="workspace-gate">
        <h1>The workspace owner must create backups.</h1>
        <a className="primary-button" href="/login">Sign in as owner</a>
      </main>
    );
  }

  return (
    <div className="backup-page">
      <header className="workspace-topbar">
        <a className="wordmark" href="/">Adeno</a>
        <p><ShieldCheck aria-hidden="true" size={16} />Owner-only recovery</p>
      </header>
      <main className="backup-layout">
        <section className="backup-heading">
          <a className="back-link" href="/workspace"><ArrowLeft aria-hidden="true" size={16} />Care dashboard</a>
          <div className="backup-mark"><KeyRound aria-hidden="true" size={22} /></div>
          <p className="section-note">Encrypted recovery copy</p>
          <h1>Make a backup you can actually restore.</h1>
          <p>
            Adeno will snapshot the database, verify every original file, include the recovery
            secret, and encrypt the complete archive before download.
          </p>
          <div className="backup-warning">
            <strong>Store two things separately.</strong>
            <p>The <code>.clb</code> file and this new backup passphrase. Losing either one makes the backup unusable.</p>
          </div>
        </section>
        <form className="backup-form" onSubmit={exportBackup}>
          <div>
            <label htmlFor="backup-account-password">Adeno account password</label>
            <input id="backup-account-password" type="password" autoComplete="current-password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} required />
            <small>This confirms that the signed-in owner requested the export.</small>
          </div>
          <div>
            <label htmlFor="backup-passphrase">New backup passphrase</label>
            <input id="backup-passphrase" type="password" autoComplete="new-password" minLength={12} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required />
            <small>Use a long phrase that is not the account password.</small>
          </div>
          <div>
            <label htmlFor="backup-confirmation">Repeat backup passphrase</label>
            <input id="backup-confirmation" type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
            <small>{confirmation && confirmation !== passphrase ? "The two backup passphrases do not match." : "Adeno never stores this passphrase."}</small>
          </div>
          <button className="primary-button backup-submit" type="submit" disabled={working || passphrase.length < 12 || passphrase !== confirmation}>
            <Download aria-hidden="true" size={18} />
            {working ? "Verifying and encrypting…" : "Create encrypted backup"}
          </button>
          <p className="auth-error" role="alert">{error}</p>
          {complete ? <p className="backup-success" role="status">Backup verified and downloaded. An encrypted server-side copy also remains in the private backup directory.</p> : null}
        </form>
      </main>
    </div>
  );
}
