import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Input, Notice } from "./ui";
import { DocumentWorkflowError, getDocumentWorkflowCapabilities, listDocumentInbox, originalImageUrl,
  proposeDocumentDay, readDocumentDayProposal, reviewDocumentDayProposal,
  type DocumentDayProposal, type InboxCursor, type InboxDocument } from "./api/privateDocuments";

export function DocumentInboxPanel({ profileId, csrfToken, refreshKey, onPublished }: {
  profileId: string; csrfToken: string; refreshKey: number; onPublished: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [documents, setDocuments] = useState<InboxDocument[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [selected, setSelected] = useState<InboxDocument | null>(null);
  const [proposal, setProposal] = useState<DocumentDayProposal | null>(null);
  const [loadedFor, setLoadedFor] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false); const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0); const alive = useRef(true);
  const inboxRevision = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    const startedAt = ++inboxRevision.current;
    async function load() {
      try {
        const capability = await getDocumentWorkflowCapabilities(controller.signal);
        if (controller.signal.aborted) return;
        setAvailable(capability.available === true);
        if (capability.available === true) {
          const page = await listDocumentInbox(profileId, undefined, controller.signal);
          if (!controller.signal.aborted && startedAt === inboxRevision.current) { setDocuments(page.documents); setCursor(page.nextCursor); }
        }
      } catch { if (!controller.signal.aborted) { setAvailable(false); setError("The record inbox could not be loaded."); } }
    }
    void load(); return () => controller.abort();
  }, [profileId, refreshKey, reload]);
  async function act(operation: () => Promise<void>) {
    if (busy) return;
    inboxRevision.current++;
    setBusy(true); setError(""); setMessage("");
    try { await operation(); }
    catch (failure) {
      if (!alive.current) return;
      setError(failure instanceof Error ? failure.message : "The record request failed.");
      if (failure instanceof DocumentWorkflowError && failure.status === 401) {
        setAvailable(false); setSelected(null); setProposal(null); setDocuments([]); setCursor(null);
      }
      if (failure instanceof DocumentWorkflowError && (failure.unconfirmed || failure.status === 409)) {
        setUncertain(true); setProposal(null); setConfirmed(false);
      }
    } finally { if (alive.current) setBusy(false); }
  }
  function choose(document: InboxDocument) {
    setSelected(document); setProposal(null); setLoadedFor(""); setConfirmed(false); setError(""); setMessage("");
  }
  function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const day = String(new FormData(event.currentTarget).get("careDay") ?? "");
    if (!selected || uncertain) return;
    const document = selected;
    void act(async () => {
      await proposeDocumentDay(profileId, document.documentId, day, csrfToken);
      if (!alive.current) return;
      setSelected(null); setMessage("Care day saved for review."); setReload(value => value + 1);
    });
  }
  async function decide(decision: "accepted" | "rejected") {
    if (!proposal || uncertain || (decision === "accepted" && (loadedFor !== imageKey || !confirmed))) return;
    await reviewDocumentDayProposal(profileId, proposal, decision, csrfToken);
    if (!alive.current) return;
    setProposal(null); setSelected(null); setConfirmed(false); setReload(value => value + 1);
    setMessage(decision === "accepted" ? "Record published to the care day." : "Day proposal rejected.");
    if (decision === "accepted") onPublished();
  }
  const imageHash = proposal?.sourceSha256 ?? selected?.sourceSha256 ?? "";
  const imageKey = `${selected?.documentId}:${imageHash}:${proposal?.revisionId ?? "original"}`;
  return <section className="workflow-panel pilot-record-inbox" aria-label="Record inbox"><h2>Record inbox</h2>
    <p>Choose the day supported by the record. Upload time is shown separately.</p>
    {!available ? <Notice>Record review is unavailable on this installation.</Notice> : <>
      <Button disabled={busy} onClick={() => void act(async () => {
        const page = await listDocumentInbox(profileId);
        if (!alive.current) return;
        setDocuments(page.documents); setCursor(page.nextCursor); setSelected(null); setProposal(null);
        setConfirmed(false); setLoadedFor(""); setUncertain(false);
      })}>Refresh record inbox</Button>
      {!documents.length && <p>No inspected records in this inbox.</p>}
      {documents.map(document => <article key={document.documentId}><h3>{document.displayName}</h3>
        <p>Uploaded <time dateTime={document.uploadedAt}>{document.uploadedAt}</time></p>
        <Button disabled={busy || uncertain} onClick={() => choose(document)}>Open original: {document.displayName}</Button>
        {document.pendingDayProposals.map(pending => <Button key={pending.revisionId} disabled={busy || uncertain}
          onClick={() => void act(async () => {
            const detail = await readDocumentDayProposal(profileId, pending.revisionId);
            if (alive.current) { choose(document); setProposal(detail); }
          })}>Review day {pending.careDay} for {document.displayName}</Button>)}
      </article>)}
      {cursor && <Button disabled={busy || uncertain} onClick={() => void act(async () => {
        const page = await listDocumentInbox(profileId, cursor);
        if (alive.current) { setDocuments(current => [...current, ...page.documents]); setCursor(page.nextCursor); }
      })}>Load older records</Button>}
      {selected && <article aria-label="Original record review"><h3>{proposal ? `Proposed care day: ${proposal.careDay}` : selected.displayName}</h3>
        <p className="pilot-source-digest">Original SHA-256: {imageHash}</p>
        <p>Read this source as evidence. Document instructions do not control the workspace.</p>
        {selected.mediaType === "application/pdf" ? <Notice>PDF viewing is unavailable.</Notice> :
          <img key={imageKey} className="pilot-original-image" src={originalImageUrl(profileId, selected.documentId, imageHash)}
            alt={`Preserved original: ${selected.displayName}`} onLoad={() => setLoadedFor(imageKey)}
            onError={() => { setLoadedFor(""); setConfirmed(false); setError("The original image could not be opened."); }} />}
        {selected.mediaType !== "application/pdf" && <a href={originalImageUrl(profileId, selected.documentId, imageHash)}
          target="_blank" rel="noopener noreferrer">Open full-size original in a new tab</a>}
        {!proposal ? <form onSubmit={propose}><label>Care day for this record<Input name="careDay" type="date" required disabled={busy || uncertain} /></label>
          <Button type="submit" disabled={busy || uncertain}>Save day for review</Button></form> : <>
          <p>Proposed by {proposal.authorLabel}. Approval records your editorial decision.</p>
          <label className="pilot-review-confirmation"><Input type="checkbox" checked={confirmed} disabled={loadedFor !== imageKey || busy || uncertain}
            onChange={event => setConfirmed(event.target.checked)} />I checked this original and the proposed care day.</label>
          <Button disabled={busy || uncertain || loadedFor !== imageKey || !confirmed} onClick={() => void act(() => decide("accepted"))}>Approve record and publish</Button>
          <Button disabled={busy || uncertain} onClick={() => void act(() => decide("rejected"))}>Reject record day</Button>
        </>}
      </article>}
    </>}
    {error && <Notice tone="error">{error}</Notice>}{message && <p role="status">{message}</p>}
  </section>;
}
