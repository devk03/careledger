# Sparse day storage proposal

Earlier storage proposal with an [unregistered day-placement draft](../app/storage/migrations/0006_sparse_care_days.sql) and a [follow-on family-access draft](../app/storage/migrations/0007_family_day_access.sql). **Neither migration is registered or applied to an existing database.** Both were executed together only on fresh fictional test databases. The second draft adds day/source grants, published snapshots, child review requests and a durable outbox, but runtime authorization and atomic publish logic remain unimplemented. Do not register these drafts for family rollout yet. The user approved draft creation and fictional-data application; an existing database target and verified backup must be identified before any real cutover. The existing Python application and its database remain the system of record.

## Key decision

The earlier design derived a day node from approved placements and notes, keyed by `(care_profile_id, care_day)`. The new requirement keeps that sparse key and no blank days, but stores an immutable snapshot whenever a populated day's approved contents change. The draft below therefore remains useful as an item-level history sketch, not a complete day-node schema.

This also makes “History through a day” a permission-scoped query over current approved material dated on or before the selected day, ordered backward. A later-uploaded file approved for an earlier care day appears on the next read. Upload time remains provenance, not the timeline key.

## Proposed additive persistence

1. `document_day_placements`: an association between an existing immutable `documents` row and a care profile. Its append-only revisions carry a care day; separate append-only reviews accept or reject each revision. Multiple documents may share a day; one document may be placed on more than one day if it actually covers multiple dates. Never rewrite the original file or use its upload date as a care date.
2. `family_notes`: a family-authored text source tied to a care profile. Append-only text/date revisions and separate reviews preserve authorship and corrections. A null day keeps an accepted note in “Date unclear.” A note is an attestation, not a clinical document or model conclusion.
3. Cross-profile constraints: a placement's document and care profile must match. Add a composite uniqueness target or equivalent database guard to the existing `documents` table, plus server-side household authorization on every read/write. A document from another family must never be attachable by guessed ID.
4. Care-day and per-item revision indexes support backward traversal after joining to the authorized care profile. Query-plan testing on synthetic data is still required; a later version may denormalize profile ID into revision rows if needed. Unreviewed placements and notes remain visible only to their permitted author/reviewers, never in ordinary family or MCP history reads.

The draft's read views select the highest **accepted** revision, so a later proposal or rejection does not hide an earlier accepted item. A later accepted retraction removes it from the current view without erasing history. Reads still require an authorized `care_profile_id` filter; the view itself is not an authorization boundary. Calendar-date validity, review permissions, duplicate placements, and safe transaction behavior need application-layer tests before registration.

**Privacy boundary:** this SQL stores care dates and family-note text in plaintext. It is a proposed schema for an explicitly trusted local database only. It must not become a hosted server-side record store under the family-controlled E2EE promise. The hosted timeline must be built from client-decrypted manifests, with only opaque ciphertext on the server. Approval to test or apply this local migration is not approval to use it in hosted production.

No existing table needs to be dropped. Existing `source_objects` and `documents` continue to preserve original bytes, hashes and upload timestamps. Existing accepted evidence remains separate from the new day placement layer; it is not silently backfilled into day nodes based on uncertain dates.

## Read contract

- `list_timeline_days`: grouped populated days, newest first, with bounded file/note counts and continuation.
- `get_history_through_day`: selected day inclusive, then earlier populated days; optional focus-range start; fresh approved data and provenance on every request. The client may traverse all pages.
- `get_approved_source_page`: bounded text from one approved document page, with source hash, page number, offset and an untrusted-content label. If text does not exist, the original remains available only through an authorized viewer path.

The Express HTTP and MCP adapters must share the same application service and a household-scoped repository. A secure production implementation still needs session/OAuth authorization, CSRF for writes, immutable object handling, audit, scan/parse isolation and the hosted encryption boundary. The current TypeScript code is a tested contract, not that complete implementation.

## Approval boundary

The additive draft pair creates new tables/views/triggers and adds `member_kind` to existing users and invitations, defaulting legacy rows to `adult`. It does not drop tables, delete records, backfill care days or cut over writes. Before touching an existing database, verify that this legacy-account default is appropriate, identify the exact database, take and test an encrypted backup, then run the approved migration under a write freeze. Registration in `app/storage/database.py` would auto-apply at Python startup, so it remains intentionally absent until the TypeScript cutover is ready. This approval does not authorize public deployment or imply that the new tables alone enforce safe reads.
