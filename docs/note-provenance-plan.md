# Structured note provenance — migration proposal

Status: awaiting explicit migration authorization. No migration file exists.

Existing data already supports account role/status, current scoped permissions,
upload account/time, note entry account/time, file IDs/hashes/pages and reviewer
history. Expose those now, without changing their authorization.

The missing capture fields are the actual reporter and the information channel.
An account used to enter a note does not establish who observed or reported it.

Proposed additive table: `family_note_provenance`, keyed by immutable note revision.
Optional bounded fields: reporter name (120 characters), source description (1000),
and one source-kind enum (family observation, clinician communication, document,
research context, unknown). An optional document ID and page number link the note
to an existing original. Do not add clinical assertions or infer reporter names.

Require note/profile/document household agreement and current source access when
creating a link. Include new fields in the same note transaction and audit trail.
Keep provenance immutable with the revision; correction creates a new revision.
Historical notes stay explicitly unspecified. Approval remains separate. Read-only
assistant responses expose linked sources only if current publication and source
permissions permit them. Revocation hides file references, names and page links.

The browser form will show reporter, source kind, source description and an
optional permitted-file/page selector. Review and history show the exact entered
metadata alongside recorded-by account and reviewer, with timestamps.

If approved: create migration 0008, apply existing plus new migration only to
fresh synthetic test databases, and test bounds, cross-profile/household links,
missing/revoked source access, immutable provenance and review/publication. Back up
production and verify restore before separately applying the approved additive
migration. Preserve all existing notes, records, accounts, grants and originals.
