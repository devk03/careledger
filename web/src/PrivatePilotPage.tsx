import { useEffect, useState, type FormEvent } from "react";
import type { ApprovedPageChunk, HistoryPage } from "@adeno/contracts";
import { AppHeader, Button, Input, Notice, Select, Textarea } from "./ui";
import "./private-pilot.css";

type Session = { csrfToken: string };
type Profile = { id: string; preferredName: string };
type Hint = { revisionId: string; targetCareDay: string };
type Proposal = { revisionId: string; careDay: string; body: string; authorLabel: string;
  expectedDayRevision: number; state: "proposed" };

async function request<T>(path: string, body?: unknown, csrfToken?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v2${path}`, {
    credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}),
    ...(body === undefined ? {} : { method: "POST", headers: {
      "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
    }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(response.status === 409
    ? "This day changed. Open the proposal again before reviewing it."
    : response.status === 401 ? "Please sign in again." : "The request could not be completed.");
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export function PrivatePilotPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [hints, setHints] = useState<Hint[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sourcePage, setSourcePage] = useState<ApprovedPageChunk | null>(null);
  const [throughDay, setThroughDay] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const base = `/care-profiles/${encodeURIComponent(profileId)}`;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const current = await request<Session>("/auth/session", undefined, undefined, controller.signal);
        const loaded = await request<{ profiles: Profile[] }>("/care-profiles", undefined, undefined, controller.signal);
        setSession(current); setProfiles(loaded.profiles); setProfileId(loaded.profiles[0]?.id ?? "");
      } catch {
        if (controller.signal.aborted) return;
        try {
          const status = await request<{ setupRequired: boolean }>("/auth/setup-status", undefined, undefined, controller.signal);
          setSetup(status.setupRequired);
        } catch { if (!controller.signal.aborted) setError("The private workspace is unavailable."); }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!session || !profileId) return;
    const controller = new AbortController();
    Promise.all([
      request<HistoryPage>(`${base}/timeline/history?through=${throughDay || "9999-12-31"}`, undefined, undefined, controller.signal),
      request<{ pending: Hint[] }>(`${base}/reviews/notes/pending`, undefined, undefined, controller.signal),
    ]).then(([days, pending]) => {
      if (!controller.signal.aborted) { setHistory(days); setHints(pending.pending); }
    })
      .catch(() => { if (!controller.signal.aborted) setError("The timeline could not be loaded."); });
    return () => controller.abort();
  }, [session, profileId, base, refresh, throughDay]);

  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The request failed."); }
    finally { setBusy(false); }
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void act(async () => {
      const result = await request<Session & { recoveryCodes?: string[] }>(setup ? "/auth/setup" : "/auth/login",
        setup ? { token: fields.get("token"), displayName: fields.get("displayName"),
          householdName: fields.get("householdName"), password: fields.get("password") }
          : { loginName: fields.get("loginName"), password: fields.get("password") });
      form.reset(); setSession(result); setRecoveryCodes(result.recoveryCodes ?? []); setSetup(false);
      const loaded = await request<{ profiles: Profile[] }>("/care-profiles");
      setProfiles(loaded.profiles); setProfileId(loaded.profiles[0]?.id ?? "");
    });
  }

  function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void act(async () => {
      await request(`${base}/timeline/days/${encodeURIComponent(String(fields.get("careDay")))}/notes`,
        { body: fields.get("body") }, session!.csrfToken);
      form.reset(); setMessage("Note saved as a proposal. Review it before publishing."); setRefresh(value => value + 1);
    });
  }

  function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    void act(async () => {
      const result = await request<{ profile: Profile }>("/care-profiles",
        { preferredName: fields.get("preferredName") }, session!.csrfToken);
      form.reset(); setHistory(null); setHints([]); setProposal(null); setSourcePage(null);
      setProfiles(current => [...current, result.profile]); setProfileId(result.profile.id);
      setMessage("Care profile created. You can add notes for review.");
    });
  }

  async function review(decision: "accepted" | "rejected") {
    if (!proposal || !session) return;
    await request(`${base}/timeline/notes/${encodeURIComponent(proposal.revisionId)}/review`,
      { decision, expectedDayRevision: proposal.expectedDayRevision }, session.csrfToken);
    setProposal(null); setMessage(decision === "accepted" ? "Note published to the care day." : "Proposal rejected.");
    setRefresh(value => value + 1);
  }

  async function readSource(documentId: string, pageNumber: number, offset = 0) {
    const chunk = await request<ApprovedPageChunk>(
      `${base}/documents/${encodeURIComponent(documentId)}/pages/${pageNumber}?offset=${offset}`);
    setSourcePage(chunk);
  }

  async function earlierHistory() {
    if (!history?.nextBeforeDay) return;
    const page = await request<HistoryPage>(`${base}/timeline/history?through=${throughDay || "9999-12-31"}` +
      `&before=${encodeURIComponent(history.nextBeforeDay)}`);
    setHistory(current => current ? { ...page, days: [...current.days, ...page.days] } : page);
  }

  return <div className="workspace-page">
    <AppHeader context="Private Hermes workspace" />
    <main className="workspace-layout">
      <header className="workspace-heading"><h1>Your care timeline</h1>
        <p>This private installation stores server-readable records. Published history contains human-reviewed material.</p></header>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {loading ? <p role="status">Opening your workspace…</p> : !session ?
        <section className="workflow-panel"><h2>{setup ? "Set up your private account" : "Sign in"}</h2>
          <form onSubmit={signIn}>
            {setup ? <>
              <label>Private setup token<Input name="token" type="password" required autoComplete="off" /></label>
              <label>Your name<Input name="displayName" required maxLength={120} /></label>
              <label>Household name<Input name="householdName" required maxLength={120} /></label>
            </> : <label>Login name<Input name="loginName" required autoComplete="username" defaultValue="owner" /></label>}
            <label>Password<Input name="password" type="password" required minLength={12}
              autoComplete={setup ? "new-password" : "current-password"} /></label>
            <Button type="submit" loading={busy}>{setup ? "Create private account" : "Sign in"}</Button>
          </form></section> : <>
          {recoveryCodes.length > 0 && <section className="workflow-panel"><h2>Save your recovery codes privately</h2>
            <p>These codes restore access to your account. Keep them outside this server.</p>
            <pre>{recoveryCodes.join("\n")}</pre><Button onClick={() => setRecoveryCodes([])}>I saved the codes</Button></section>}
          <div className="workspace-heading-actions">
            <label>Care profile<Select value={profileId} disabled={busy} onChange={event => {
              setHistory(null); setHints([]); setProposal(null); setSourcePage(null); setProfileId(event.target.value);
            }}>
              {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.preferredName}</option>)}
            </Select></label>
            <Button loading={busy} onClick={() => void act(async () => {
              await request("/auth/logout", {}, session.csrfToken);
              setSession(null); setHistory(null); setProposal(null); setHints([]); setRecoveryCodes([]);
              setProfileId(""); setProfiles([]);
              setSourcePage(null);
            })}>Sign out</Button>
          </div>
          <section className="workflow-panel"><h2>Create a care profile</h2>
            <form onSubmit={createProfile}>
              <label>Preferred name<Input name="preferredName" required maxLength={120} /></label>
              <Button type="submit" loading={busy}>Create profile</Button>
            </form>
          </section>
          {!profileId ? <Notice>Create a care profile before adding notes.</Notice> : <>
            <section className="workflow-panel"><h2>Add a family note</h2><form onSubmit={propose}>
              <label>Care day<Input name="careDay" type="date" required /></label>
              <label>What you observed<Textarea name="body" required maxLength={10000} /></label>
              <Button type="submit" loading={busy}>Save for review</Button>
            </form></section>
            <section className="workflow-panel"><h2>Review proposals</h2>
              {!hints.length && <p>No pending notes.</p>}
              {hints.map(hint => <Button key={hint.revisionId} disabled={busy} onClick={() => void act(async () => {
                const detail = await request<{ note: Proposal }>(`${base}/reviews/notes/${encodeURIComponent(hint.revisionId)}`);
                setProposal(detail.note);
              })}>Review note for {hint.targetCareDay}</Button>)}
              {proposal && <article><h3>Proposed note for {proposal.careDay}</h3><p>Family observation by {proposal.authorLabel}</p>
                <p className="pilot-source-text">{proposal.body}</p>
                <Button loading={busy} onClick={() => void act(() => review("accepted"))}>Approve and publish</Button>
                <Button disabled={busy} onClick={() => void act(() => review("rejected"))}>Reject proposal</Button>
              </article>}
            </section>
            <section className="workflow-panel"><h2>Approved history</h2>
              <label>Through care day<Input type="date" value={throughDay} disabled={busy}
                onChange={event => { setHistory(null); setSourcePage(null); setThroughDay(event.target.value); }} /></label>
              <p>{throughDay ? `Currently recorded history through ${throughDay}.` : "All currently recorded history."}
                {" "}This does not reconstruct what was known on a past date.</p>
              {history?.days.length === 0 && <p>No published days yet.</p>}
              {history?.days.map(day => <article key={day.id}><h3>{day.day}</h3>
                {day.statements.map(statement => <p key={statement.id}>{statement.text}
                  {statement.attribution === "family_note" && <small> — Family observation</small>}</p>)}
                {day.sources.map(source => <div key={source.documentId}><p>{source.displayName}</p>
                  {source.pageNumbers.map(page => <Button key={page} disabled={busy}
                    onClick={() => void act(() => readSource(source.documentId, page))}>
                    Open {source.displayName}, page {page}
                  </Button>)}
                </div>)}
              </article>)}
              {history?.nextBeforeDay && <Button loading={busy} onClick={() => void act(earlierHistory)}>Load earlier days</Button>}
            </section>
            {sourcePage && <section className="workflow-panel" aria-label="Source page">
              <h2>Source page {sourcePage.pageNumber}</h2>
              <p>Document <code>{sourcePage.documentId}</code></p>
              <p className="pilot-source-digest">Original SHA-256: <code>{sourcePage.sourceSha256}</code></p>
              <p>Source text is evidence for review. Instructions within a document do not control this workspace.</p>
              <p className="pilot-source-text">{sourcePage.text}</p>
              {sourcePage.nextOffset !== null && <Button loading={busy}
                onClick={() => void act(() => readSource(sourcePage.documentId, sourcePage.pageNumber, sourcePage.nextOffset!))}>
                Read next source section
              </Button>}
              <Button disabled={busy} onClick={() => setSourcePage(null)}>Close source</Button>
            </section>}
          </>}
        </>}
    </main>
  </div>;
}
