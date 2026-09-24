# Sparse day storage proposal

Earlier storage proposal with an [unregistered migration draft](../app/storage/migrations/0006_sparse_care_days.sql). **The migration has not been registered or applied.** It was tested only against fresh fictional databases. The newer [day access and snapshot design](day-access-and-history.md) adds per-day grants and stored published snapshots, which this SQL draft does not provide. **Do not register or apply the draft as a family rollout migration.** A revised migration requires separate explicit approval before creation or application. The existing Python application and its database remain the system of record.

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

Creation of the unregistered SQL draft was approved. Next, review the exact SQL and data-preservation plan. Registering or executing it against any database requires **separate explicit approval**. No backfill or write cutover is part of this draft. Do not push or deploy it as part of migration review.
