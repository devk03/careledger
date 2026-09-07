import {
  ArrowLeft,
  Check,
  ClipboardList,
  FileQuestion,
  FileText,
  ListChecks,
  Plus,
  Printer,
  Search,
  ShieldCheck,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

type Session = {
  authenticated: boolean;
  csrf_token: string | null;
  user: { display_name: string; role?: string } | null;
};
type Profile = { id: string; preferred_name: string };
type Source = { document_id: string; page_number: number };
type Claim = {
  claim_id: string;
  statement: string;
  plain_language: string | null;
  kind: string;
  event_date: string | null;
  sources: Source[];
};
type Question = {
  id: string;
  text: string;
  priority: string;
  state: string;
  due_date: string | null;
};
type Followup = {
  id: string;
  title: string;
  source: string;
  state: string;
  due_date: string | null;
};
type Decision = {
  id: string;
  title: string;
  decided_at: number;
  rationale: string | null;
};
type Dashboard = {
  profile_id: string;
  preferred_name: string;
  what_we_know: Claim[];
  what_this_means: Claim[];
  what_remains_unknown: Claim[];
  timeline: Claim[];
  questions: Question[];
  followups: Followup[];
  decisions: Decision[];
};
type SearchResult = {
  title: string;
  body: string;
  document_id: string | null;
  page_number: number | null;
};

export function WorkspacePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [question, setQuestion] = useState("");
  const [priority, setPriority] = useState("at_next_visit");
  const [followup, setFollowup] = useState("");
  const [decision, setDecision] = useState("");
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const sessionResponse = await fetch("/api/auth/session", { credentials: "same-origin" });
        const current = (await sessionResponse.json()) as Session;
        if (cancelled) return;
        setSession(current);
        if (!current.authenticated) return;
        const profilesResponse = await fetch("/api/care-profiles", {
          credentials: "same-origin",
        });
        const loaded = (await profilesResponse.json()) as Profile[];
        if (cancelled) return;
        setProfiles(loaded);
        const requested = new URLSearchParams(window.location.search).get("profile");
        const selected = loaded.some((profile) => profile.id === requested)
          ? requested ?? ""
          : loaded[0]?.id ?? "";
        setProfileId(selected);
      } catch {
        if (!cancelled) setError("Adeno could not open this care dashboard.");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    fetch(`/api/care-profiles/${profileId}/workspace`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : Promise.reject(response)))
      .then((loaded: Dashboard) => {
        if (!cancelled) setDashboard(loaded);
      })
      .catch(() => {
        if (!cancelled) setError("Adeno could not load this family's current plan.");
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  async function addQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.csrf_token || !profileId) return;
    setWorking("question");
    try {
      const created = await mutate<Question>(
        `/api/care-profiles/${profileId}/questions`,
        { text: question, priority, due_date: null },
        session.csrf_token,
      );
      setDashboard((current) =>
        current ? { ...current, questions: [...current.questions, created] } : current,
      );
      setQuestion("");
    } catch {
      setError("Adeno could not save this question. Nothing was changed.");
    } finally {
      setWorking("");
    }
  }

  async function addFollowup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.csrf_token || !profileId) return;
    setWorking("followup");
    try {
      const created = await mutate<Followup>(
        `/api/care-profiles/${profileId}/followups`,
        { title: followup, due_date: null },
        session.csrf_token,
      );
      setDashboard((current) =>
        current ? { ...current, followups: [...current.followups, created] } : current,
      );
      setFollowup("");
    } catch {
      setError("Adeno could not save this next step. Nothing was changed.");
    } finally {
      setWorking("");
    }
  }

  async function addDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.csrf_token || !profileId) return;
    setWorking("decision");
    try {
      const created = await mutate<Decision>(
        `/api/care-profiles/${profileId}/decisions`,
        {
          title: decision,
          rationale: rationale || null,
          decided_at: Math.floor(Date.now() / 1000),
        },
        session.csrf_token,
      );
      setDashboard((current) =>
        current ? { ...current, decisions: [created, ...current.decisions] } : current,
      );
      setDecision("");
      setRationale("");
    } catch {
      setError("Adeno could not save this decision. Nothing was changed.");
    } finally {
      setWorking("");
    }
  }

  async function complete(kind: "questions" | "followups", id: string) {
    if (!session?.csrf_token) return;
    setWorking(id);
    try {
      const updated = await mutate<Question | Followup>(
        `/api/${kind}/${id}/state`,
        { state: "completed" },
        session.csrf_token,
      );
      setDashboard((current) =>
        current
          ? {
              ...current,
              [kind]: current[kind].map((item) => (item.id === id ? updated : item)),
            }
          : current,
      );
    } catch {
      setError("Adeno could not mark this complete. Nothing was changed.");
    } finally {
      setWorking("");
    }
  }

  async function searchEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profileId || !searchText.trim()) return;
    setWorking("search");
    setError("");
    try {
      const response = await fetch(
        `/api/care-profiles/${profileId}/search?q=${encodeURIComponent(searchText.trim())}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) throw new Error("search failed");
      setSearchResults((await response.json()) as SearchResult[]);
    } catch {
      setError("Adeno could not search the accepted evidence.");
    } finally {
      setWorking("");
    }
  }

  if (session && !session.authenticated) {
    return (
      <main className="workspace-gate">
        <h1>Sign in to open the care dashboard.</h1>
        <a className="primary-button" href="/login">Sign in</a>
      </main>
    );
  }

  return (
    <div className="workspace-page">
      <header className="workspace-topbar">
        <a className="wordmark" href="/">Adeno</a>
        <p><ShieldCheck aria-hidden="true" size={16} />Private family workspace</p>
      </header>
      <main className="workspace-layout">
        <header className="workspace-heading">
          <a className="back-link" href="/records"><ArrowLeft aria-hidden="true" size={16} />Records</a>
          <div className="workspace-title-row">
            <div>
              <p className="section-note">Care dashboard</p>
              <h1>{dashboard ? `Today for ${dashboard.preferred_name}` : "Opening the family plan…"}</h1>
              <p>Reviewed facts, questions, decisions, and next steps—kept separate on purpose.</p>
            </div>
            <div className="workspace-heading-actions">
              <label htmlFor="workspace-profile">Care profile</label>
              <select id="workspace-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.preferred_name}</option>)}
              </select>
              <button className="outline-button" type="button" onClick={() => window.print()}>
                <Printer aria-hidden="true" size={16} />Print visit view
              </button>
              <a
                className="outline-button"
                href={`/api/care-profiles/${profileId}/appointment-brief`}
                download
              >
                <FileText aria-hidden="true" size={16} />Download brief
              </a>
              {session?.user?.role === "owner" ? (
                <a className="text-link backup-link" href="/backup">Back up this workspace</a>
              ) : null}
            </div>
          </div>
          <form className="evidence-search" role="search" onSubmit={searchEvidence}>
            <Search aria-hidden="true" size={17} />
            <label className="sr-only" htmlFor="evidence-search">Search accepted evidence</label>
            <input id="evidence-search" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search accepted evidence" maxLength={200} />
            <button type="submit" disabled={!searchText.trim() || working === "search"}>{working === "search" ? "Searching…" : "Search"}</button>
          </form>
          <p className="workspace-error" role="alert" aria-live="polite">{error}</p>
        </header>

        {dashboard ? (
          <>
            {searchResults ? (
              <section className="search-results" aria-labelledby="search-results-title">
                <div><p className="section-note">Local evidence search</p><h2 id="search-results-title">{searchResults.length ? `${searchResults.length} accepted result${searchResults.length === 1 ? "" : "s"}` : "No accepted evidence matched"}</h2></div>
                <div>
                  {searchResults.map((result, index) => (
                    <article key={`${result.document_id}-${result.page_number}-${index}`}>
                      <strong>{result.title.replaceAll("_", " ")}</strong>
                      <p>{result.body}</p>
                      {result.document_id && result.page_number ? <a href={`/api/documents/${result.document_id}/content#page=${result.page_number}`} target="_blank" rel="noreferrer">Open source page {result.page_number}</a> : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="care-summary" aria-label="Current care summary">
              <SummarySection title="What we know" empty="No accepted facts yet." claims={dashboard.what_we_know} />
              <SummarySection title="What the records may mean" empty="No reviewed interpretations yet." claims={dashboard.what_this_means} />
              <SummarySection title="What remains unknown" empty="No open unknowns recorded." claims={dashboard.what_remains_unknown} />
              <SummarySection title="Recent timeline" empty="Dated reviewed facts will appear here." claims={dashboard.timeline} />
            </section>

            <section className="workflow-grid" aria-label="Care coordination">
              <article className="workflow-panel">
                <header><FileQuestion aria-hidden="true" size={20} /><div><p className="section-note">Ask next</p><h2>Questions for clinicians</h2></div></header>
                <form onSubmit={addQuestion}>
                  <label htmlFor="new-question">Add a question</label>
                  <textarea id="new-question" value={question} onChange={(event) => setQuestion(event.target.value)} required maxLength={500} />
                  <select aria-label="Question priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
                    <option value="before_next_visit">Before the next visit</option>
                    <option value="at_next_visit">At the next visit</option>
                    <option value="when_possible">When possible</option>
                  </select>
                  <button className="panel-add" type="submit" disabled={!question.trim() || working === "question"}><Plus aria-hidden="true" size={16} />Add question</button>
                </form>
                <WorkflowList items={dashboard.questions} kind="questions" working={working} onComplete={complete} />
              </article>

              <article className="workflow-panel">
                <header><ListChecks aria-hidden="true" size={20} /><div><p className="section-note">Do next</p><h2>Family follow-ups</h2></div></header>
                <form onSubmit={addFollowup}>
                  <label htmlFor="new-followup">Add a next step</label>
                  <textarea id="new-followup" value={followup} onChange={(event) => setFollowup(event.target.value)} required maxLength={500} />
                  <button className="panel-add" type="submit" disabled={!followup.trim() || working === "followup"}><Plus aria-hidden="true" size={16} />Add next step</button>
                </form>
                <WorkflowList items={dashboard.followups} kind="followups" working={working} onComplete={complete} />
              </article>

              <article className="workflow-panel decisions-panel">
                <header><ClipboardList aria-hidden="true" size={20} /><div><p className="section-note">Remember why</p><h2>Decisions made</h2></div></header>
                <form onSubmit={addDecision}>
                  <label htmlFor="new-decision">Record a decision</label>
                  <input id="new-decision" value={decision} onChange={(event) => setDecision(event.target.value)} required maxLength={500} />
                  <label htmlFor="decision-rationale">Why? <span>Optional</span></label>
                  <textarea id="decision-rationale" value={rationale} onChange={(event) => setRationale(event.target.value)} maxLength={2000} />
                  <button className="panel-add" type="submit" disabled={!decision.trim() || working === "decision"}><Plus aria-hidden="true" size={16} />Record decision</button>
                </form>
                <div className="workflow-items">
                  {dashboard.decisions.map((item) => (
                    <div className="workflow-item" key={item.id}>
                      <div><strong>{item.title}</strong><p>{new Date(item.decided_at * 1000).toLocaleDateString()}</p>{item.rationale ? <p>{item.rationale}</p> : null}</div>
                    </div>
                  ))}
                  {!dashboard.decisions.length ? <p className="panel-empty">No decisions recorded yet.</p> : null}
                </div>
              </article>
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

function SummarySection({ title, empty, claims }: { title: string; empty: string; claims: Claim[] }) {
  return (
    <article>
      <h2>{title}</h2>
      {claims.length ? claims.map((claim) => (
        <div className="summary-claim" key={claim.claim_id}>
          <p>{claim.statement}</p>
          {claim.plain_language ? <small>{claim.plain_language}</small> : null}
          {claim.sources.map((source) => (
            <a key={`${source.document_id}-${source.page_number}`} href={`/api/documents/${source.document_id}/content#page=${source.page_number}`} target="_blank" rel="noreferrer">Source page {source.page_number}</a>
          ))}
        </div>
      )) : <p className="panel-empty">{empty}</p>}
    </article>
  );
}

function WorkflowList({ items, kind, working, onComplete }: {
  items: (Question | Followup)[];
  kind: "questions" | "followups";
  working: string;
  onComplete: (kind: "questions" | "followups", id: string) => Promise<void>;
}) {
  return (
    <div className="workflow-items">
      {items.map((item) => {
        const label = "text" in item ? item.text : item.title;
        return (
          <div className={`workflow-item ${item.state === "completed" ? "workflow-item-done" : ""}`} key={item.id}>
            <div><strong>{label}</strong><p>{_workflowMeta(item)}</p></div>
            {item.state !== "completed" ? <button type="button" aria-label={`Mark complete: ${label}`} disabled={working === item.id} onClick={() => void onComplete(kind, item.id)}><Check aria-hidden="true" size={16} /></button> : null}
          </div>
        );
      })}
      {!items.length ? <p className="panel-empty">Nothing here yet.</p> : null}
    </div>
  );
}

async function mutate<T>(url: string, body: object, csrf: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("mutation failed");
  return (await response.json()) as T;
}

function _workflowMeta(item: Question | Followup): string {
  if ("priority" in item) {
    if (item.priority === "before_next_visit") return "Before the next visit";
    if (item.priority === "at_next_visit") return "At the next visit";
    return "When possible";
  }
  return item.source === "caregiver_task" ? "Family task" : "Clinician instruction";
}
