import { useEffect, useState } from "react";
import type { FamilyAccessOverview } from "@adeno/contracts";
import { Badge, Button, Notice } from "./ui";

export function FamilyAccessPanel() {
  const [access, setAccess] = useState<FamilyAccessOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v2/family/access", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Access details could not be loaded. Refresh to try again.");
        const result = await response.json() as FamilyAccessOverview;
        if (!result || !["household", "self"].includes(result.visibility) || !Array.isArray(result.members) || !Array.isArray(result.profiles) ||
          !result.members.every(member => Array.isArray(member.intakeProfiles) && Array.isArray(member.days) && Array.isArray(member.documents)))
          throw new Error("Invalid access inventory");
        return result;
      }).then(result => { if (!controller.signal.aborted) setAccess(result); })
      .catch(() => { if (!controller.signal.aborted) setError("Access details could not be loaded. Refresh to try again."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);
  const person = (id: string) => access?.profiles.find(profile => profile.id === id)?.preferredName ?? "Unavailable person";
  return <section id="family-access" className="workflow-panel pilot-family-access" aria-labelledby="access-title">
    <div className="pilot-section-label">SIGN-IN ACCOUNTS & ACCESS</div>
    <h2 id="access-title">People &amp; permissions</h2>
    <p>These are people who can sign in. Care profiles above are the people whose records you organize; creating one does not give anyone access.</p>
    <Button disabled={loading} onClick={() => { setLoading(true); setError(""); setAccess(null); setReload(value => value + 1); }}>Refresh permissions</Button>
    {loading && <p role="status">Checking current access…</p>}
    {error && <Notice>{error}</Notice>}
    {access?.visibility === "self" && <p>You can see your own permissions. The owner can see every account in this household.</p>}
    {access?.members.map(member => <article key={member.id} className="pilot-access-member">
      <header><h3>{member.displayName}{member.id === access.currentUserId ? " (you)" : ""}</h3>
        <Badge>{member.role === "owner" ? "Owner" : "Caregiver"}</Badge></header>
      <p className="pilot-field-hint">{member.status === "active" ? "Active" : member.status === "pending" ? "Pending" : "Disabled"} · {member.memberKind === "adult" ? "Adult account" : "Child account"}</p>
      {member.status !== "active" ? <p>No effective access while this account is {member.status}.</p> : member.allProfiles ? <dl className="pilot-permission-list">
        <div><dt>Read</dt><dd>All care profiles, records, inbox items and published timelines in this household.</dd></div>
        <div><dt>Add &amp; propose</dt><dd>Upload records, propose care dates and add family notes for every person.</dd></div>
        <div><dt>Review &amp; publish</dt><dd>Approve or reject proposed dates and notes for every person.</dd></div>
        <div><dt>Manage access</dt><dd>Manage household access grants. Invitations are disabled on this private installation.</dd></div>
      </dl> : <>
        <dl className="pilot-permission-list">
          <div><dt>Add records &amp; notes</dt><dd>{member.intakeProfiles.length ? member.intakeProfiles.map(person).join(", ") : "No people assigned for intake."}</dd></div>
          <div><dt>Read timeline</dt><dd>{member.days.length ? "Only the care days listed below." : "No care days granted."}</dd></div>
          <div><dt>Read original files</dt><dd>{member.documents.length ? "Only the files listed below." : "No original files granted."}</dd></div>
          <div><dt>Review &amp; publish</dt><dd>{member.memberKind === "child" ? "Not permitted for child accounts." : member.days.some(day => day.level === "publish") ? "Only days marked Review & publish below, with source-file access required for records." : "No publishing days granted."}</dd></div>
          <div><dt>Manage access</dt><dd>Owner only.</dd></div>
        </dl>
        {member.days.length > 0 && <details><summary>Care-day permissions ({member.days.length})</summary>
          <ul>{member.days.map(day => <li key={`${day.careProfileId}:${day.careDay}`}>
            <strong>{person(day.careProfileId)} · {day.careDay}</strong>
            <p>{day.level === "view" ? "Read timeline" : day.level === "contribute" ? "Read timeline · propose record dates when source access permits" : "Read timeline · propose record dates · review & publish"}</p>
            <p>Granted by {day.grantedBy.displayName} · <time dateTime={day.grantedAt}>{day.grantedAt}</time></p>
          </li>)}</ul>
        </details>}
        {member.documents.length > 0 && <details><summary>Permitted files ({member.documents.length})</summary>
          <ul>{member.documents.map(document => <li key={document.documentId}>
            <strong>{document.displayName}</strong><p>{person(document.careProfileId)} · {document.basis === "own_upload" ? "Own upload; access depends on current intake permission" : "Explicit source-file grant"}</p>
          </li>)}</ul>
        </details>}
      </>}
    </article>)}
    <p className="pilot-field-hint">Originals and approved revisions are preserved. Updating means proposing a new entry, not silently rewriting evidence. A file grant does not grant every timeline day; assistant source reads also require current publication and day access.</p>
  </section>;
}
