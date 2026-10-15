# Structured note provenance — approved rollout

Status: creation/testing and the separate production application were explicitly
approved by the owner on October 14. Migration `0008_note_provenance.sql` is applied
on Hermes. The running private app exposes structured note source fields.

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

Validation covers migration 0008 on fresh synthetic databases, including bounds, cross-profile/household links,
missing/revoked source access, immutable provenance and review/publication. Back up production and verify restore before separately applying the additive
migration, only after production approval. Preserve all existing notes, records, accounts, grants and originals.

## Operator command

Stop application writers and retain a fresh encrypted snapshot before invoking
`node server/dist/runPrivateNoteMigration.js /data/case.sqlite /migration.sql`
with `ADENO_NOTE_MIGRATION_APPROVED=0008`. Use the reviewed private runtime in a
network-disabled, read-only-root, bounded container; mount only the approved data
root and the exact reviewed SQL file. The command validates the existing schema,
audit chain and pinned migration digest, applies one transaction, updates the
ledger/user version, and verifies integrity. It creates no accounts or notes.
A repeated invocation on verified v8 is a no-op. Application startup never applies
migrations. Both v7 and v8 are supported during this explicit rollout.

## Production receipt — October 14, 2026

Runtime `adeno-private:2ea22b5` applied the exact reviewed migration digest
`0a87325d2e3bf447fbfa4c3a64e4c830bd1cde2419cb4e8d349c347f3052074d`
with writers stopped. The bounded, network-disabled operator container returned
`{"migration":8,"applied":true,"integrity":"ok"}`. Foreign-key checks passed.
Fingerprints of all 67 existing non-ledger tables and all 34 object files matched
before/after. The new provenance table remained empty; no historical data was
backfilled. Private row fingerprints and operational receipts remain outside Git.

Immediately before applying, an encrypted 14,142,983-byte snapshot was copied
off-host and successfully restored on the owner's Mac. Its pinned SHA-256 is
`5232238efdfa24fd871d93c1f42c9d79bc8fe822b1c22db978c5b278b96ff3d6`.
The private decryption identity stayed on the Mac. The application restarted on
the same runtime and HTTPS readiness returned `ready`.

The signed-in production browser showed reporter, information source and source
details fields. Selecting Source document exposed permitted-file and page
selectors. Existing records remained visible. No note or review was submitted
during verification. The screenshot is retained outside Git as
`note-provenance-live.png` in the local task visualization directory.

After this migration, retain a runtime that supports schema v8. Do not roll back
to a v7-only image against the upgraded database.
