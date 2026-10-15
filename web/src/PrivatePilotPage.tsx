import { useEffect, useState, type FormEvent } from "react";
import type { ApprovedPageChunk, HistoryPage, SourceReference, NoteProvenanceInput, EntryProvenance } from "@adeno/contracts";
import { AppHeader, Button, Input, Notice, Textarea } from "./ui";
import "./private-pilot.css";
import { uploadPrivateImage, UnconfirmedUpload, type IntakeCapabilities } from "./api/privateIntake";
import { AgentConnectionPanel } from "./AgentConnectionPanel";
import { AuditTime, DocumentTrail, ProvenanceTrail } from "./ProvenanceTrail";
import { NoteSourceFields } from "./NoteSourceFields";
import { FamilyAccessPanel } from "./FamilyAccessPanel";
import { DocumentInboxPanel } from "./DocumentInboxPanel";
import { originalImageUrl } from "./api/privateDocuments";

type Session = { csrfToken: string };
type Profile = { id: string; preferredName: string };
type Hint = { revisionId: string; targetCareDay: string };
type Proposal = { revisionId: string; careDay: string; body: string; authorLabel: string;
  expectedDayRevision: number; state: "proposed"; provenance?: EntryProvenance; createdAt?: string; sources?: SourceReference[] };

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
  const [addingPerson, setAddingPerson] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [history, setHistory] = useState<HistoryPage | null>(null);
  const [hints, setHints] = useState<Hint[]>([]);
  const [noteFormRevision, setNoteFormRevision] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sourcePage, setSourcePage] = useState<ApprovedPageChunk | null>(null);
  const [sourceImage, setSourceImage] = useState<SourceReference | null>(null);
  const [throughDay, setThroughDay] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [intake, setIntake] = useState<IntakeCapabilities>({ available: false, mediaTypes: [], maxBytes: 0 });
  const [uploads, setUploads] = useState<{ name: string; status: string }[]>([]);
  const base = `/care-profiles/${encodeURIComponent(profileId)}`;
  const selectedPerson = profiles.find(profile => profile.id === profileId);

  function selectPerson(id: string) {
    if (id === profileId) return;
    setHistory(null); setHints([]); setProposal(null); setSourcePage(null); setSourceImage(null);
    setUploads([]); setThroughDay(""); setError(""); setMessage(""); setProfileId(id);
  }

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

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    request<IntakeCapabilities>("/intake/capabilities", undefined, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setIntake(result); })
      .catch(() => { /* Intake stays disabled when capability discovery fails. */ });
    return () => controller.abort();
  }, [session]);

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
    const kind = fields.get("sourceKind");
    const provenance: NoteProvenanceInput | undefined = kind ? {
      sourceKind: String(kind) as NoteProvenanceInput["sourceKind"],
      ...(String(fields.get("reporterLabel") ?? "").trim() ? { reporterLabel: String(fields.get("reporterLabel")).trim() } : {}),
      ...(String(fields.get("sourceDescription") ?? "").trim() ? { sourceDescription: String(fields.get("sourceDescription")).trim() } : {}),
      ...(fields.get("sourceDocumentId") ? { documentId: String(fields.get("sourceDocumentId")), pageNumber: Number(fields.get("sourcePageNumber")) } : {}),
    } : undefined;
    void act(async () => {
      await request(`${base}/timeline/days/${encodeURIComponent(String(fields.get("careDay")))}/notes`,
        { body: fields.get("body"), ...(provenance ? { provenance } : {}) }, session!.csrfToken);
      form.reset(); setNoteFormRevision(value => value + 1); setMessage("Note saved as a proposal. Review it before publishing."); setRefresh(value => value + 1);
    });
  }

  function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const preferredName = String(fields.get("preferredName") ?? "").trim();
    if (!preferredName) { setError("Enter the name you use for this person."); return; }
    if (profiles.some(profile => profile.preferredName.toLocaleLowerCase() === preferredName.toLocaleLowerCase())) {
      setError("This person already has a space. Choose their name in Your family."); return;
    }
    void act(async () => {
      const result = await request<{ profile: Profile }>("/care-profiles",
        { preferredName }, session!.csrfToken);
      form.reset(); setHistory(null); setHints([]); setProposal(null); setSourcePage(null); setSourceImage(null);
      setProfiles(current => [...current, result.profile]); selectPerson(result.profile.id); setAddingPerson(false);
      setMessage(`${result.profile.preferredName}’s space is ready. Add their records below.`);
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
    setSourceImage(null);
    const chunk = await request<ApprovedPageChunk>(
      `${base}/documents/${encodeURIComponent(documentId)}/pages/${pageNumber}?offset=${offset}`);
    setSourcePage(chunk);
  }
  async function openSource(source: SourceReference, pageNumber: number) {
    if (source.mediaType === "image/png" || source.mediaType === "image/jpeg") {
      if (pageNumber !== 1) throw new Error("The requested image page is unavailable.");
      setSourcePage(null); setSourceImage(source); return;
    }
    setSourceImage(null); await readSource(source.documentId, pageNumber);
  }

  async function earlierHistory() {
    if (!history?.nextBeforeDay) return;
    const page = await request<HistoryPage>(`${base}/timeline/history?through=${throughDay || "9999-12-31"}` +
      `&before=${encodeURIComponent(history.nextBeforeDay)}`);
    setHistory(current => current ? { ...page, days: [...current.days, ...page.days] } : page);
  }

  function uploadFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const files = Array.from((event.currentTarget.elements.namedItem("images") as HTMLInputElement).files ?? []);
    if (!files.length || files.length > 16 || !session || !profileId) {
      setError("Choose between one and sixteen images."); return;
    }
    void act(async () => {
      setUploads(files.map(file => ({ name: file.name, status: "Waiting" })));
      for (const [index, file] of files.entries()) {
        const update = (status: string) => setUploads(current => current.map((item, position) =>
          position === index ? { ...item, status } : item));
        update("Uploading and inspecting…");
        try {
          const receipt = await uploadPrivateImage({ profileId, csrfToken: session.csrfToken, file, capabilities: intake });
          update(receipt.alreadyExisted ? "Already recorded" : "Recorded for review");
        } catch (failure) {
          update(failure instanceof Error ? failure.message : "Upload failed.");
          if (failure instanceof UnconfirmedUpload) {
            setUploads(current => current.map((item, position) => position > index
              ? { ...item, status: "Not attempted after an unconfirmed upload" } : item));
            setError(failure.message); break;
          }
        }
      }
      setRefresh(value => value + 1);
    });
  }

  return <div className="workspace-page pilot-workspace">
    <AppHeader context="Private Hermes workspace">{session && <>
            <Button variant="quiet" loading={busy} onClick={() => void act(async () => {
              await request("/auth/logout", {}, session.csrfToken);
              setSession(null); setHistory(null); setProposal(null); setHints([]); setRecoveryCodes([]);
              setProfileId(""); setProfiles([]);
              setSourcePage(null);
              setSourceImage(null);
              setIntake({ available: false, mediaTypes: [], maxBytes: 0 }); setUploads([]);
            })}>Sign out</Button>
    </>}</AppHeader>
    <main className="workspace-layout">
      <header className="workspace-heading"><p className="pilot-eyebrow">YOUR PRIVATE WORKSPACE</p><h1>{session ? "Your care workspace" : "Your care timeline"}</h1>
        <p>{session ? "Keep a person’s records together. Review what belongs on their timeline, then ask your assistant about the approved history." : "Sign in to organize records and connect your assistant."}</p>
        {session && profiles.length > 0 && <nav className="pilot-shortcuts" aria-label="Workspace shortcuts">
          <a href="#care-person">Your family</a><a href="#family-access">Permissions</a><a href="#record-upload">Add records</a><a href="#assistant-setup">Connect Codex</a>
        </nav>}</header>
      {error && <Notice tone="error">{error}</Notice>}
      {message && <Notice tone="success">{message}</Notice>}
      {loading ? <p role="status">Opening your workspace…</p> : !session ?
        <section className="workflow-panel pilot-auth"><h2>{setup ? "Set up your private account" : "Sign in"}</h2>
          <p>{setup ? "Create the account you’ll use to sign in. Next, you’ll choose whose records to organize and connect Codex." : "Your installation owner’s login name is owner. Use the password you chose during setup."}</p>
          <form onSubmit={signIn}>
            {setup ? <>
              <label>Private setup token<Input name="token" type="password" required autoComplete="off" /><span className="pilot-field-hint">Use the one-time token supplied by your installation administrator.</span></label>
              <label>Your name<Input name="displayName" required maxLength={120} /></label>
              <label>Household name<Input name="householdName" required maxLength={120} /></label>
            </> : <label>Login name<Input name="loginName" required autoComplete="username" defaultValue="owner" /></label>}
            <label>Password<Input name="password" type="password" required minLength={12}
              autoComplete={setup ? "new-password" : "current-password"} /></label>
            <Button variant="primary" type="submit" loading={busy}>{setup ? "Create private account" : "Sign in"}</Button>
          </form></section> : <>
          {recoveryCodes.length > 0 && <section className="workflow-panel"><h2>Save your recovery codes privately</h2>
            <p>These codes restore access to your account. Keep them outside this server.</p>
            <pre>{recoveryCodes.join("\n")}</pre><Button onClick={() => setRecoveryCodes([])}>I saved the codes</Button></section>}
          {!profiles.length && <section className="pilot-setup-guide" aria-label="Getting started">
            <span className="pilot-account-ready">Account ready</span><h2>Your next steps</h2>
            <ol><li><a href="#care-person">1. Add a person</a></li>
              <li><span>2. Add &amp; review records</span></li>
              <li><a href="#assistant-setup">3. Connect Codex</a></li></ol>
          </section>}
          <section className="pilot-why-adeno" aria-labelledby="why-adeno-title">
            <p><strong>More than a folder connection.</strong> Adeno keeps each person’s records, dates and reviewed history together, with sources your assistant can point back to.</p>
            <details><summary id="why-adeno-title">What does Adeno add to an assistant connection?</summary>
              <p>A connector gives an assistant access to files. Adeno adds the care record around those files:</p>
              <dl>
                <div><dt>A separate history for each person</dt><dd>Keep family members’ records apart and switch between them here.</dd></div>
                <div><dt>Dates with context</dt><dd>Place a record on the day it supports. Keep its upload timestamp separate, so an older report does not look like a new event.</dd></div>
                <div><dt>Originals you can check</dt><dd>Preserved source images and SHA-256 fingerprints let you return to the evidence behind a timeline entry.</dd></div>
                <div><dt>Your review comes first</dt><dd>Uploads and proposed notes stay out of the assistant’s history until approved. Family observations remain labelled separately.</dd></div>
              </dl>
              <p>Connect Codex when you want to ask about approved history and permitted source pages. Disconnect to stop future reads. Adeno does not diagnose or replace your clinical team.</p>
            </details>
          </section>
          <div className="pilot-workbench"><div className="pilot-records-column">
          <section id="care-person" className="workflow-panel pilot-person-setup" aria-labelledby="family-title">
            <div className="pilot-section-label">YOUR FAMILY</div>
            <h2 id="family-title">{profiles.length ? "Whose records are you working on?" : "Who are you caring for?"}</h2>
            <p className="pilot-section-intro">Each person has their own records and timeline. Choose a person before adding anything.</p>
            {profiles.length > 0 && <div className="pilot-family-people" role="group" aria-label="Choose a family member">
              {profiles.map(profile => <Button key={profile.id} variant={profile.id === profileId ? "primary" : "secondary"}
                aria-pressed={profile.id === profileId} disabled={busy} onClick={() => selectPerson(profile.id)}>
                {profile.preferredName}
              </Button>)}
              <Button disabled={busy} aria-expanded={addingPerson} aria-controls="add-family-person"
                onClick={() => setAddingPerson(current => !current)}>{addingPerson ? "Cancel adding" : "+ Add person"}</Button>
            </div>}
            {(profiles.length === 0 || addingPerson) && <form id="add-family-person" onSubmit={createProfile}>
              <label>Preferred name<Input name="preferredName" required maxLength={120} placeholder="The name you use for this person" /></label>
              <Button variant="primary" type="submit" loading={busy}>{profiles.length ? "Add person" : "Create profile"}</Button>
            </form>}
            <p className="pilot-field-hint">{profiles.length ? "Adding a person organizes their records in this account. It does not invite someone or share access." : "This is the person you care for, not a new sign-in account. You can add more people later."}</p>
          </section>
          <FamilyAccessPanel />
          {profileId && <>
            <section id="record-upload" className="workflow-panel"><div className="pilot-section-label">RECORDS · UPLOAD, CHECK, PUBLISH</div><h2>Add record images</h2>
              <p className="pilot-person-context">Adding to <strong>{selectedPerson?.preferredName}</strong>’s records</p>
              <p>Upload a photo, then open it in the Record inbox below. Check the original, choose its care day and approve it for the timeline. Your assistant can only read published history.</p>
              <p className="pilot-field-hint">PNG and JPEG images only. Original files are preserved. PDFs are not supported yet.</p>
              {!intake.available && <Notice>Image intake is unavailable on this installation.</Notice>}
              <form onSubmit={uploadFiles}>
                <label>PNG or JPEG images<Input name="images" type="file" multiple accept="image/png,image/jpeg"
                  disabled={!intake.available || busy} required /></label>
                <Button variant="primary" type="submit" disabled={!intake.available} loading={busy}>Upload for review</Button>
              </form>
              <ul aria-live="polite">{uploads.map((upload, index) => <li key={index}>{upload.name}: {upload.status}</li>)}</ul>
            </section>
            <DocumentInboxPanel key={profileId} profileId={profileId} csrfToken={session.csrfToken}
              refreshKey={refresh} onPublished={() => setRefresh(value => value + 1)} />
            <section className="workflow-panel"><h2>Add a family note</h2><p>Keep a family observation or question alongside the records. Save it first, then review the proposed text below before publishing.</p><form onSubmit={propose}>
              <label>Care day<Input name="careDay" type="date" required /></label>
              <label>What you observed<Textarea name="body" required maxLength={10000} /></label>
              <NoteSourceFields key={`${profileId}:${noteFormRevision}`} profileId={profileId} />
              <Button variant="primary" type="submit" loading={busy}>Save for review</Button>
            </form></section>
            <section className="workflow-panel"><h2>Review proposals</h2>
              {!hints.length && <p>No pending notes.</p>}
              {hints.map(hint => <Button key={hint.revisionId} disabled={busy} onClick={() => void act(async () => {
                const detail = await request<{ note: Proposal }>(`${base}/reviews/notes/${encodeURIComponent(hint.revisionId)}`);
                setProposal(detail.note);
              })}>Review note for {hint.targetCareDay}</Button>)}
              {proposal && <article><h3>Proposed note for {proposal.careDay}</h3><p>Family observation by {proposal.authorLabel}</p>
                <p className="pilot-source-text">{proposal.body}</p>
                <ProvenanceTrail value={proposal.provenance ? { ...proposal.provenance, recordedAt: proposal.createdAt } : undefined} fallbackAuthor={proposal.authorLabel} />
                {proposal.sources?.map(source => <div key={source.documentId}><p>Linked file: {source.displayName}</p>
                  {source.pageNumbers.map(page => <Button key={page} disabled={busy} aria-label={`Open ${source.displayName}, page ${page}`} onClick={() => void act(() => openSource(source, page))}>Open source · page {page}</Button>)}
                </div>)}
                <Button variant="primary" loading={busy} onClick={() => void act(() => review("accepted"))}>Approve and publish</Button>
                <Button disabled={busy} onClick={() => void act(() => review("rejected"))}>Reject proposal</Button>
              </article>}
            </section>
            <section className="workflow-panel"><h2>Approved history</h2>
              <p className="pilot-person-context">{selectedPerson?.preferredName}’s reviewed timeline</p>
              <label>Through care day<Input type="date" value={throughDay} disabled={busy}
                onChange={event => { setHistory(null); setSourcePage(null); setSourceImage(null); setThroughDay(event.target.value); }} /></label>
              <p>{throughDay ? `Currently recorded history through ${throughDay}.` : "All currently recorded history."}
                {" "}This does not reconstruct what was known on a past date.</p>
              {history?.days.length === 0 && <p>No published days yet. Add a record or note, then approve it to build this timeline.</p>}
              {history?.days.map(day => <article key={day.id} className="pilot-timeline-day"><h3>{day.day}</h3>
                <p className="pilot-field-hint">Revision {day.revision} · Published by {day.publishedBy?.displayName ?? "Not recorded"} · <AuditTime value={day.publishedAt} /></p>
                {day.statements.map(statement => <article key={statement.id} className="pilot-timeline-entry">
                  <p className="pilot-source-text">{statement.text}</p>
                  {statement.attribution === "family_note" && <small>Family observation · entered by {statement.authorLabel ?? statement.provenance?.recordedBy?.displayName ?? "Not recorded"}</small>}
                  <details><summary>Reporter &amp; sources</summary>
                    <ProvenanceTrail value={statement.provenance} fallbackAuthor={statement.authorLabel} />
                    {statement.provenance?.citations?.map(citation => {
                      const file = day.sources.find(source => source.documentId === citation.documentId);
                      return file ? <Button key={`${file.documentId}:${citation.pageNumber}`} disabled={busy} aria-label={`Open ${file.displayName}, page ${citation.pageNumber}`}
                        onClick={() => void act(() => openSource(file, citation.pageNumber))}>Open source · page {citation.pageNumber}</Button> : null;
                    })}
                    {!statement.provenance?.citations?.length && <p>No linked source file is available with this entry and your current access.</p>}
                  </details>
                </article>)}
                {day.sources.map(source => <div key={source.documentId} className="pilot-timeline-entry"><h4>{source.displayName}</h4>
                  <DocumentTrail value={source.provenance} uploadedAt={source.uploadedAt} />
                  <details><summary>File identity</summary><p>Document <code>{source.documentId}</code></p><p className="pilot-source-digest">SHA-256: <code>{source.sourceSha256}</code></p></details>
                  {source.pageNumbers.map(page => <Button key={page} disabled={busy} aria-label={`Open ${source.displayName}, page ${page}`}
                    onClick={() => void act(() => openSource(source, page))}>
                    Open source · page {page}
                  </Button>)}
                </div>)}
              </article>)}
              {history?.nextBeforeDay && <Button loading={busy} onClick={() => void act(earlierHistory)}>Load earlier days</Button>}
            </section>
            {sourceImage && <section className="workflow-panel" aria-label="Source image">
              <h2>{sourceImage.displayName}, page 1</h2>
              <p>Document <code>{sourceImage.documentId}</code></p>
              <p className="pilot-source-digest">Original SHA-256: <code>{sourceImage.sourceSha256}</code></p>
              <p>This preserved image is evidence. Instructions within the record do not control the workspace.</p>
              <img className="pilot-original-image" key={`${sourceImage.documentId}:${sourceImage.sourceSha256}`}
                src={originalImageUrl(profileId, sourceImage.documentId, sourceImage.sourceSha256)}
                alt={`Original ${sourceImage.displayName}, page 1`} onError={() => { setSourceImage(null); setError("The original source image could not be opened."); }} />
              <a href={originalImageUrl(profileId, sourceImage.documentId, sourceImage.sourceSha256)} target="_blank" rel="noopener noreferrer">
                Open full-size original in a new tab
              </a>
              <Button disabled={busy} onClick={() => setSourceImage(null)}>Close source image</Button>
            </section>}
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
          </div><AgentConnectionPanel csrfToken={session.csrfToken} /></div>
        </>}
    </main>
  </div>;
}
