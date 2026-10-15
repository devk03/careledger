import type { DocumentProvenance, EntryProvenance } from "@adeno/contracts";
const kinds: Record<string, string> = {
  family_note: "Family note", family_observation: "Family observation", clinician_communication: "Reported clinician communication",
  document: "Source document", source_documented_fact: "Source-documented fact", clinician_interpretation: "Clinician interpretation",
  user_attested_confirmed_fact: "User-attested fact", unconfirmed_recollection: "Unconfirmed recollection",
  research_context: "Research context", agent_inference: "AI inference", unknown: "Not specified",
};
export function AuditTime({ value }: { value?: string }) {
  if (!value) return <>Not recorded</>;
  const parsed = new Date(value);
  return <time dateTime={value} title={value}>{Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }) : value}</time>;
}
export function ProvenanceTrail({ value, fallbackAuthor }: { value?: EntryProvenance; fallbackAuthor?: string }) {
  return <dl className="pilot-provenance" aria-label="Entry provenance">
    <div><dt>Information type</dt><dd>{kinds[value?.sourceKind ?? ""] ?? "Not recorded"}</dd></div>
    <div><dt>Reported by</dt><dd>{value?.reporterLabel ?? value?.reportedBy?.displayName ?? "Not recorded; the entry account does not identify the reporter."}</dd></div>
    <div><dt>Information came from</dt><dd>{value?.sourceDescription ?? "No source description recorded."}</dd></div>
    <div><dt>Entered through account</dt><dd>{value?.recordedBy?.displayName ?? fallbackAuthor ?? "Not recorded"}</dd></div>
    <div><dt>Entered at</dt><dd><AuditTime value={value?.recordedAt} /></dd></div>
    <div><dt>Reviewed by</dt><dd>{value?.reviewedBy?.displayName ?? "No review metadata recorded"}{value?.reviewedAt && <> · <AuditTime value={value.reviewedAt} /></>}</dd></div>
  </dl>;
}
export function DocumentTrail({ value, uploadedAt }: { value?: DocumentProvenance; uploadedAt: string }) {
  return <div className="pilot-document-trail">
    <dl className="pilot-provenance" aria-label="File provenance">
      <div><dt>Uploaded through account</dt><dd>{value?.uploadedBy?.displayName ?? "Not recorded"}</dd></div>
      <div><dt>Uploaded at</dt><dd><AuditTime value={uploadedAt} /></dd></div>
      <div><dt>Document date</dt><dd>{value?.recordDate ?? "Not recorded separately"}{value?.recordDateText && <> · {value.recordDateText}</>}</dd></div>
    </dl>
    {value?.placement && <details><summary>Placement & review</summary><ProvenanceTrail value={value.placement} /></details>}
  </div>;
}
