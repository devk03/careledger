import { useEffect, useState } from "react";
import { Button, Input, Notice, Select, Textarea } from "./ui";
import { listDocumentInbox, type InboxCursor, type InboxDocument } from "./api/privateDocuments";

export function NoteSourceFields({ profileId }: { profileId: string }) {
  const [available, setAvailable] = useState(false);
  const [kind, setKind] = useState("family_observation");
  const [files, setFiles] = useState<(Pick<InboxDocument, "documentId" | "displayName"> & { pageCount?: number })[]>([]);
  const [cursor, setCursor] = useState<InboxCursor | null>(null);
  const [fileId, setFileId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/v2/note-provenance/capabilities", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok || (await response.json() as { available?: boolean }).available !== true) return;
        if (!controller.signal.aborted) setAvailable(true);
        const page = await listDocumentInbox(profileId, undefined, controller.signal);
        if (!controller.signal.aborted) { setFiles(page.documents); setCursor(page.nextCursor); }
        // Contributors may have explicit source grants in addition to their own inbox.
        const accessResponse = await fetch("/api/v2/family/access", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!accessResponse.ok) return;
        const access = await accessResponse.json() as import("@adeno/contracts").FamilyAccessOverview;
        const member = Array.isArray(access.members) ? access.members.find(person => person.id === access.currentUserId) : undefined;
        if (!controller.signal.aborted && member && Array.isArray(member.documents)) setFiles(current => [
          ...current, ...member.documents.filter(document => document.careProfileId === profileId && !current.some(file => file.documentId === document.documentId))
            .map(document => ({ documentId: document.documentId, displayName: document.displayName })),
        ]);
      } catch { if (!controller.signal.aborted) setError("Source file choices could not be loaded. You can still save a note without a file link."); }
    }
    void load(); return () => controller.abort();
  }, [profileId]);
  if (!available) return <p className="pilot-field-hint">This installation saves the entry account and time. Separate reporter and source fields are not available yet.</p>;
  const selected = files.find(file => file.documentId === fileId);
  return <fieldset className="pilot-note-source"><legend>Who reported this, and where did it come from?</legend>
    <p className="pilot-field-hint">The reporter may be different from the person typing. These details stay proposed with the note until reviewed.</p>
    <label>Reported by<Input name="reporterLabel" required maxLength={120} placeholder="Person’s name, or Unknown" /></label>
    <label>Information source<Select name="sourceKind" value={kind} onChange={event => setKind(event.target.value)}>
      <option value="family_observation">Family observation</option><option value="clinician_communication">Clinician conversation or message</option>
      <option value="document">Source document</option><option value="research_context">Research context</option><option value="unknown">Unknown</option>
    </Select></label>
    <label>Source details<Textarea name="sourceDescription" maxLength={1000} placeholder="For example: who said it, which appointment or message, and when. Don’t treat recollection as a signed report." /></label>
    {kind === "document" && <>
      <label>Source file<Select name="sourceDocumentId" value={fileId} required onChange={event => setFileId(event.target.value)}>
        <option value="">Choose a permitted file</option>
        {files.map(file => <option key={file.documentId} value={file.documentId}>{file.displayName}</option>)}
      </Select></label>
      <label>Source page<Input key={fileId} name="sourcePageNumber" type="number" min={1} max={selected?.pageCount ?? 1000} defaultValue={1} required /></label>
      <p className="pilot-field-hint">Choose the page of the uploaded file. A PDF page copy is an image file with one page.</p>
      {cursor && <Button loading={loading} onClick={() => {
        setLoading(true); setError("");
        void listDocumentInbox(profileId, cursor).then(page => { setFiles(current => [...current, ...page.documents]); setCursor(page.nextCursor); })
          .catch(() => setError("More source files could not be loaded." )).finally(() => setLoading(false));
      }}>Load older source files</Button>}
    </>}
    {error && <Notice>{error}</Notice>}
  </fieldset>;
}
