import {
  ArrowRight,
  BrainCircuit,
  Check,
  FileCheck2,
  FileText,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

type Session = {
  authenticated: boolean;
  csrf_token: string | null;
  user: { display_name: string } | null;
};

type CareProfile = {
  id: string;
  preferred_name: string;
  created_at: number;
};

type DocumentRecord = {
  id: string;
  display_name: string;
  media_type: string;
  source_sha256: string;
  byte_size: number;
  page_count: number;
  status: string;
  scan_verdict: string;
  duplicate_source: boolean;
};

type AIStatus = {
  enabled: boolean;
  provider: string;
  model: string | null;
  external_transfer_required: boolean;
};

type ClaimProposal = {
  revision_id: string;
  claim_id: string;
  statement: string;
  plain_language: string | null;
  kind: string;
  fact_type: string | null;
  certainty: string;
  qualifier_text: string | null;
  event_date: string | null;
  citations: { document_id: string; page_number: number; quote: string | null }[];
};

export function RecordsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [profiles, setProfiles] = useState<CareProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [profileName, setProfileName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [aiStatus, setAiStatus] = useState<AIStatus>({
    enabled: false,
    provider: "disabled",
    model: null,
    external_transfer_required: false,
  });
  const [consentDocumentId, setConsentDocumentId] = useState("");
  const [reviewDocumentId, setReviewDocumentId] = useState("");
  const [proposals, setProposals] = useState<ClaimProposal[]>([]);
  const [reviewWorkingId, setReviewWorkingId] = useState("");

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
        const loadedProfiles = (await profilesResponse.json()) as CareProfile[];
        if (cancelled) return;
        setProfiles(loadedProfiles);
        setSelectedProfileId(loadedProfiles[0]?.id ?? "");
        try {
          const aiResponse = await fetch("/api/ai/status", { credentials: "same-origin" });
          if (aiResponse.ok && !cancelled) {
            setAiStatus((await aiResponse.json()) as AIStatus);
          }
        } catch {
          // AI is optional. Record intake remains fully usable when no provider is configured.
        }
      } catch {
        if (!cancelled) {
          setError("Adeno could not load the private workspace. Check the server and try again.");
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedProfileId) {
      return;
    }
    let cancelled = false;
    async function refresh() {
      try {
        const response = await fetch(`/api/care-profiles/${selectedProfileId}/documents`, {
          credentials: "same-origin",
        });
        const loaded = (await response.json()) as DocumentRecord[];
        if (!cancelled) setDocuments(loaded);
      } catch {
        if (!cancelled) setError("Adeno could not load the record list.");
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedProfileId]);

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.csrf_token) return;
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/care-profiles", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf_token,
        },
        body: JSON.stringify({ preferred_name: profileName }),
      });
      const result = (await response.json()) as CareProfile & { error?: string };
      if (!response.ok) {
        setError("Adeno could not create this care profile. Check the name and try again.");
        return;
      }
      setProfiles((current) => [...current, result]);
      setSelectedProfileId(result.id);
      setProfileName("");
    } catch {
      setError("Adeno could not reach its private server. Please try again.");
    } finally {
      setWorking(false);
    }
  }

  async function uploadRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFile || !selectedProfileId || !session?.csrf_token) return;
    setWorking(true);
    setError("");
    const body = new FormData();
    body.append("record", selectedFile);
    try {
      const response = await fetch(`/api/care-profiles/${selectedProfileId}/documents`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": session.csrf_token },
        body,
      });
      const result = (await response.json()) as DocumentRecord & {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        setError(result.message ?? "Adeno could not safely add this record.");
        return;
      }
      setDocuments((current) => [result, ...current]);
      setSelectedFile(null);
      const fileInput = document.querySelector<HTMLInputElement>("#record-file");
      if (fileInput) fileInput.value = "";
    } catch {
      setError("Adeno could not reach its private server. Please try again.");
    } finally {
      setWorking(false);
    }
  }

  async function requestAnalysis(documentId: string) {
    if (!session?.csrf_token) return;
    setReviewWorkingId(documentId);
    setError("");
    try {
      const response = await fetch(`/api/documents/${documentId}/analysis`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf_token,
        },
        body: JSON.stringify({ acknowledge_external_transfer: true }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(_analysisError(result.error));
        return;
      }
      setConsentDocumentId("");
    } catch {
      setError("Adeno could not reach the configured AI provider. The original is still safe.");
    } finally {
      setReviewWorkingId("");
    }
  }

  async function openReview(documentId: string) {
    setReviewWorkingId(documentId);
    setError("");
    try {
      const response = await fetch(`/api/documents/${documentId}/proposals`, {
        credentials: "same-origin",
      });
      const result = (await response.json()) as ClaimProposal[] & { error?: string };
      if (!response.ok) {
        setError("Adeno could not open these proposed facts. Please try again.");
        return;
      }
      setProposals(result);
      setReviewDocumentId(documentId);
    } catch {
      setError("Adeno could not open these proposed facts. Please try again.");
    } finally {
      setReviewWorkingId("");
    }
  }

  async function reviewProposal(revisionId: string, decision: "accepted" | "rejected") {
    if (!session?.csrf_token) return;
    setReviewWorkingId(revisionId);
    setError("");
    try {
      const response = await fetch(`/api/evidence/${revisionId}/review`, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf_token,
        },
        body: JSON.stringify({ decision }),
      });
      const result = (await response.json()) as { document_status?: string; error?: string };
      if (!response.ok) {
        setError("This proposal may already have been reviewed. Refresh and check again.");
        return;
      }
      setProposals((current) => current.filter((proposal) => proposal.revision_id !== revisionId));
      if (result.document_status) {
        setDocuments((current) =>
          current.map((record) =>
            record.id === reviewDocumentId
              ? { ...record, status: result.document_status ?? record.status }
              : record,
          ),
        );
      }
    } catch {
      setError("Adeno could not save this review. Nothing was changed.");
    } finally {
      setReviewWorkingId("");
    }
  }

  if (session && !session.authenticated) {
    return (
      <main className="records-gate">
        <LockKeyhole aria-hidden="true" size={25} />
        <h1>Sign in to open the family workspace.</h1>
        <p>Adeno does not expose record names or counts before authentication.</p>
        <a className="primary-button" href="/login">
          Sign in
          <ArrowRight aria-hidden="true" size={18} />
        </a>
      </main>
    );
  }

  return (
    <div className="records-page">
      <header className="records-topbar">
        <a className="wordmark" href="/" aria-label="Adeno home">
          Adeno
        </a>
        <p>
          <ShieldCheck aria-hidden="true" size={16} />
          {session?.user ? `Private workspace · ${session.user.display_name}` : "Opening private workspace…"}
        </p>
      </header>

      <main className="records-layout">
        <header className="records-heading">
          <p className="section-note">Originals first</p>
          <h1>Add records without losing where anything came from.</h1>
          <p>
            Adeno checks each PDF or photo, preserves the original bytes, and records a
            SHA-256 fingerprint before proposing any explanation.
          </p>
        </header>

        <aside className="records-actions" aria-label="Record intake">
          {profiles.length ? (
            <>
              <label className="profile-select" htmlFor="care-profile">
                <span>Care profile</span>
                <select
                  id="care-profile"
                  value={selectedProfileId}
                  onChange={(event) => setSelectedProfileId(event.target.value)}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.preferred_name}
                    </option>
                  ))}
                </select>
              </label>
              <a className="dashboard-link" href={`/workspace?profile=${selectedProfileId}`}>
                Open the care dashboard
                <ArrowRight aria-hidden="true" size={16} />
              </a>
              <form className="upload-form" onSubmit={uploadRecord}>
                <label className="file-picker" htmlFor="record-file">
                  <Upload aria-hidden="true" size={21} />
                  <span>{selectedFile ? selectedFile.name : "Choose a PDF or clear photo"}</span>
                  <small>PDF, JPEG, or PNG · up to 30 MB</small>
                </label>
                <input
                  id="record-file"
                  className="sr-only"
                  type="file"
                  aria-label="Choose a PDF or clear photo"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                />
                <button
                  className="primary-button records-submit"
                  type="submit"
                  disabled={!selectedFile || working}
                >
                  <Plus aria-hidden="true" size={18} />
                  {working ? "Checking the record…" : "Add this record"}
                </button>
              </form>
            </>
          ) : (
            <form className="profile-form" onSubmit={createProfile}>
              <label htmlFor="profile-name">Who are you helping?</label>
              <input
                id="profile-name"
                value={profileName}
                onChange={(event) => setProfileName(event.target.value)}
                placeholder="A name your family recognizes"
                maxLength={120}
                required
              />
              <small>Use a nickname or relationship if you prefer.</small>
              <button className="primary-button" type="submit" disabled={working}>
                {working ? "Creating the profile…" : "Create the care profile"}
                <ArrowRight aria-hidden="true" size={18} />
              </button>
            </form>
          )}
          <p className="records-error" role="alert" aria-live="polite">
            {error}
          </p>
        </aside>

        <section className="records-list" aria-labelledby="records-title">
          <div className="records-list-heading">
            <div>
              <p className="section-note">Source library</p>
              <h2 id="records-title">{documents.length ? "Records being organized" : "No records yet"}</h2>
            </div>
            <p>{documents.length} {documents.length === 1 ? "record" : "records"}</p>
          </div>
          {documents.length ? (
            <div className="record-rows">
              {documents.map((document) => (
                <article className="record-row" key={document.id}>
                  <div className="record-icon" aria-hidden="true">
                    {document.status === "processing" ? <FileText size={20} /> : <FileCheck2 size={20} />}
                  </div>
                  <div>
                    <h3>{document.display_name}</h3>
                    <p>
                      {document.page_count} {document.page_count === 1 ? "page" : "pages"} ·{" "}
                      {_formatBytes(document.byte_size)}
                    </p>
                    <p className="record-provenance" title={document.source_sha256}>
                      Source fingerprint {document.source_sha256.slice(0, 12)}…
                    </p>
                  </div>
                  <div className="record-state">
                    <strong>{_statusLabel(document.status)}</strong>
                    <span>{_scanLabel(document.scan_verdict)}</span>
                    {document.duplicate_source ? <span>Original bytes already preserved</span> : null}
                    {document.status === "ready" && aiStatus.enabled ? (
                      <button
                        className="record-action"
                        type="button"
                        onClick={() => setConsentDocumentId(document.id)}
                      >
                        <BrainCircuit aria-hidden="true" size={16} />
                        Explain this record
                      </button>
                    ) : null}
                    {document.status === "ready" && !aiStatus.enabled ? (
                      <span>AI is off · the original is safely stored</span>
                    ) : null}
                    {document.status === "needs_review" ? (
                      <button
                        className="record-action"
                        type="button"
                        disabled={reviewWorkingId === document.id}
                        onClick={() => void openReview(document.id)}
                      >
                        <FileCheck2 aria-hidden="true" size={16} />
                        {reviewWorkingId === document.id ? "Opening…" : "Review proposed facts"}
                      </button>
                    ) : null}
                  </div>
                  {consentDocumentId === document.id ? (
                    <section className="analysis-consent" aria-labelledby={`consent-${document.id}`}>
                      <div>
                        <p className="review-label">Before anything leaves Adeno</p>
                        <h4 id={`consent-${document.id}`}>Send this original for an explanation?</h4>
                        <p>
                          The full record will be sent to {_providerLabel(aiStatus.provider)} using
                          the explanation connection set up for this Adeno installation. The
                          result returns as a draft that you must review before trusting it.
                        </p>
                        <p className="analysis-model">Model: {aiStatus.model}</p>
                      </div>
                      <div className="consent-actions">
                        <button
                          className="quiet-action"
                          type="button"
                          onClick={() => setConsentDocumentId("")}
                        >
                          Keep it local
                        </button>
                        <button
                          className="primary-button"
                          type="button"
                          disabled={reviewWorkingId === document.id}
                          onClick={() => void requestAnalysis(document.id)}
                        >
                          {reviewWorkingId === document.id ? "Sending safely…" : "Send and explain"}
                          <ArrowRight aria-hidden="true" size={17} />
                        </button>
                      </div>
                    </section>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="records-empty">
              <FileText aria-hidden="true" size={23} />
              <p>Add one original report or a clear photo. Adeno will keep its source attached.</p>
            </div>
          )}
        </section>

        {reviewDocumentId ? (
          <section className="review-workbench" aria-labelledby="review-title">
            <header>
              <div>
                <p className="section-note">Human review required</p>
                <h2 id="review-title">Check every proposed fact against its source.</h2>
              </div>
              <button
                className="quiet-action"
                type="button"
                onClick={() => {
                  setReviewDocumentId("");
                  setProposals([]);
                }}
              >
                Close review
              </button>
            </header>
            {proposals.length ? (
              <div className="proposal-list">
                {proposals.map((proposal) => (
                  <article className="proposal-card" key={proposal.revision_id}>
                    <div className="proposal-copy">
                      <p className="review-label">AI draft · not trusted yet</p>
                      <h3>{proposal.statement}</h3>
                      {proposal.plain_language ? (
                        <div className="plain-explanation">
                          <strong>In simpler words</strong>
                          <p>{proposal.plain_language}</p>
                        </div>
                      ) : null}
                      <p className="evidence-label">
                        {_evidenceLabel(proposal.kind)} · {_certaintyLabel(proposal)}
                      </p>
                    </div>
                    <aside className="citation-panel">
                      <p className="review-label">Exact source</p>
                      {proposal.citations.map((citation) => (
                        <blockquote key={`${citation.document_id}-${citation.page_number}`}>
                          <p>{citation.quote ?? "Location marked on the source image."}</p>
                          <cite>Page {citation.page_number}</cite>
                          <a
                            className="source-link"
                            href={`/api/documents/${citation.document_id}/content#page=${citation.page_number}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open the original page
                            <ArrowRight aria-hidden="true" size={15} />
                          </a>
                        </blockquote>
                      ))}
                    </aside>
                    <div className="proposal-actions">
                      <button
                        className="reject-action"
                        type="button"
                        disabled={reviewWorkingId === proposal.revision_id}
                        onClick={() => void reviewProposal(proposal.revision_id, "rejected")}
                      >
                        <X aria-hidden="true" size={17} />
                        Reject draft
                      </button>
                      <button
                        className="accept-action"
                        type="button"
                        disabled={reviewWorkingId === proposal.revision_id}
                        onClick={() => void reviewProposal(proposal.revision_id, "accepted")}
                      >
                        <Check aria-hidden="true" size={17} />
                        {reviewWorkingId === proposal.revision_id ? "Saving…" : "Accept as sourced"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="review-complete" role="status">
                <FileCheck2 aria-hidden="true" size={22} />
                <div>
                  <h3>Review complete.</h3>
                  <p>There are no unreviewed AI drafts left for this record.</p>
                </div>
              </div>
            )}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function _formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function _scanLabel(verdict: string): string {
  if (verdict === "clean") return "Malware scan completed";
  if (verdict === "not_configured") return "File structure checked · malware scanner not configured";
  if (verdict === "unavailable") return "Malware scanner unavailable";
  return "Safety review required";
}

function _statusLabel(status: string): string {
  if (status === "processing") return "Preparing the original";
  if (status === "ready") return "Ready to explain";
  if (status === "needs_review") return "Draft facts need your review";
  if (status === "complete") return "Reviewed";
  return "Needs attention";
}

function _providerLabel(provider: string): string {
  if (provider === "openrouter") return "OpenRouter";
  if (provider === "openai") return "OpenAI";
  return "the configured AI gateway";
}

function _analysisError(code?: string): string {
  if (code === "DOCUMENT_NOT_READY") return "This original is still being prepared.";
  if (code === "AI_NOT_CONFIGURED") return "Add a caregiver-owned AI key before requesting an explanation.";
  return "Adeno could not queue this explanation. The original was not changed.";
}

function _evidenceLabel(kind: string): string {
  if (kind === "clinician_interpretation") return "Clinician interpretation in the source";
  if (kind === "source_documented_fact") return "Directly documented in the source";
  return "Source-linked statement";
}

function _certaintyLabel(proposal: ClaimProposal): string {
  if (proposal.certainty === "qualified") {
    return `keeps the source word “${proposal.qualifier_text ?? "qualified"}”`;
  }
  if (proposal.certainty === "uncertain") return "uncertainty preserved";
  return "stated directly";
}
