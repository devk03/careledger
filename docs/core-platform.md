# Adeno core platform

Scope decision: 2026-09-07. Hosted-first, open source, adult caregivers. This is the next-build specification, not a description of finished functionality. Outbound communication is deferred.

## The one loop to make excellent

After a treatment, consultation, new result or discharge, a caregiver adds the documents and a quick note. Adeno prepares a source-linked family-update draft. A permitted caregiver reviews and approves it. Each adult signs into the same family workspace to read the approved update and see their own responsibilities.

One factual update, different personal views—not separately generated accounts of what happened. Short and detailed views must derive from the same approved content. No email, WhatsApp, SMS or push is required in this increment.

## Five views

| View | Core job |
| --- | --- |
| Home | Latest approved update, what changed, unresolved questions and my open tasks; switch to whole-family responsibilities. |
| Add an update | Save unorganized text and documents to a care event; distinguish actual event date, document date and upload time; allow unknown dates. |
| Review | Read draft sections beside source pages; edit, reject or approve with uncertainty and attribution visible. |
| Records & timeline | Browse immutable originals and events; find documents behind any update; never order clinical events solely by upload time. |
| Family | Invite adults, see membership and roles, revoke access, and manage personal account settings. |

Tasks and clinician questions are embedded in Home and event details initially, not extra top-level products. No child/teen portals in the first increment.

## Family updates

An update contains: what happened; what the records say; a short plain-language explanation; what is not known; and clinician-directed next steps or caregiver tasks. Source claims link to a document/page. Personal observations retain author and observation date, not a fabricated document citation. Missing dates and contradictory records remain explicit.

Lifecycle: draft → in review → approved. Approval records actor, time and version. Later corrections create a new revision; never silently overwrite an approved update. Changed source evidence marks affected drafts stale and requires renewed review. Concurrency checks prevent one person's approval from overwriting another person's edits. Preview exactly what other members will see before approval.

No AI action publishes, assigns a task, changes permissions or converts an inference into a source-documented fact. Human approval is editorial acceptance, not validation of medical truth. If AI is unavailable or funds are exhausted, users can still save documents/notes, write an update manually and use existing content.

## Individual accounts, shared facts

Proposed initial roles, subject to security review:

- Family admin: manage invitations and membership, plus editor abilities. Admin does not automatically mean legal authority over the patient's information; require the appropriate authorization before uploading or inviting.
- Editor: add records/notes, review and approve updates, propose or assign family tasks.
- Reader: read approved family updates and their supporting records, ask questions, and mark their own tasks complete. No publication or membership changes.

For the first increment, membership means access to that family's shared approved records. State this clearly before invitation. Do not imply private per-document compartments exist. Editors can see draft material; readers cannot. Explanation length is a preference, not an access-control setting. Server authorization must protect every document, thumbnail, search result, update, task, export and direct URL; hiding controls is insufficient.

Invitations must be scoped, expiring, one-use and bound to a verified recipient identity. Revocation must invalidate future access and pending invitations. With E2EE, rotate/wrap keys appropriately and disclose that previously downloaded or decrypted copies cannot be recalled. Last-admin removal, account recovery and lost-key recovery require explicit designs before implementation.

## Task rules

Every task records owner, reason, provenance, status and optional due date. Label it as a clinician instruction, caregiver task or unapproved proposal. No inferred medical urgency. A family member may complete their own task; privileged changes remain audited. “Done” is an organizational status, not evidence that treatment occurred unless separately documented or attested.

## Build order

1. Validate the full loop in the isolated fictional-data UI, including draft/approved/empty/error states. Do not advertise multi-user capability based on a UI mock.
2. Design hosted identity, family membership, authorization and encryption/recovery boundaries together. Threat-model cross-family access and operator access. Keep current managed-startup guard until implemented protections satisfy it.
3. Propose the smallest additive data-model changes for memberships, care events, update revisions/approval and task ownership. **Ask before creating or applying any migration.** Do not repurpose or destroy the community database.
4. Implement authenticated event intake and manually authored reviewed updates first. Test two distinct adult logins and a second unrelated family before adding generation.
5. Add bounded AI drafting with explicit provider-transfer consent, citations, injection containment and strict funded usage reservations. No silent free-to-paid fallback. AI must never be needed to read saved information.
6. Complete accessible personal views, audit/export, encrypted storage/key lifecycle, retention/deletion and recovery validation. Only then consider a small hosted cohort with real records.

## Acceptance gates

- Two independently authenticated adults see the same approved update and different assigned-task lists; a reader cannot inspect drafts or publish by calling the API directly.
- A second family's session cannot obtain any record, page, search hit, update or export from the first, including guessed identifiers.
- An editor can save an incomplete event, recover a draft, review sources, publish and correct it without losing version history; conflicting edits fail visibly.
- Revoked/expired invitations and revoked memberships fail on direct requests, not only navigation. Record the limits of revocation for previously downloaded content.
- Source links resolve for authorized readers. Unknown dates, conflicting findings and family observations retain their categories.
- Clinical content is never diagnosed or prescribed by the platform; explanation copy remains personal informational use. Actual behavior, not disclaimers alone, is reviewed before launch.
- Existing records and manual workflows remain usable during provider outages, exhausted allowances and failed generation.
- Tests use wholly fictional data. No real documents, API keys or private deployment details enter public Git history or test artifacts.
- Hosted launch meets E2EE, recovery, consent, bounded spending and operational security requirements; no public launch on the strength of a visual preview alone.

## Explicitly later

Outbound family notifications, WhatsApp conversations, calendar synchronization, broad web research/trial discovery, donation/payment interfaces, child-specific framing and advanced per-document sharing. Preserve their research as backlog without allowing them to expand this increment. Required security and financial loss-prevention controls are not deferred simply because payment UI is.
