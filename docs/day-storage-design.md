# Sparse day storage proposal

Design proposal only. **No migration has been created or applied.** Request explicit maintainer approval before either step. The existing Python application and its database remain the system of record until an additive path is tested.

## Key decision

A day node does not need its own stored row. Its stable key is `(care_profile_id, care_day)`. The timeline groups approved file placements and family notes by that calendar day when read. If neither exists, there is no visible node. No blank days, event graph, summary table, vector index, or AI memory is required.

This also makes “History through a day” a permission-scoped query over current approved material dated on or before the selected day, ordered backward. A later-uploaded file approved for an earlier care day appears on the next read. Upload time remains provenance, not the timeline key.

## Proposed additive persistence

1. `document_day_placements`: an association between an existing immutable `documents` row and a care day. Multiple documents may share a day; one document may be placed on more than one day if it actually covers multiple dates. Store profile ID, document ID, care day, who placed it, when, review state, reviewer and review time. Preserve corrections as revision/audit records; never rewrite the original file or use its upload date as a care date.
2. `family_notes`: a family-authored text source tied to a care profile and an optional care day. A null day keeps it in “Date unclear.” Preserve author, creation time, review state and revisions. A note is an attestation, not a clinical document or model conclusion.
3. Cross-profile constraints: a placement's document and care profile must match. Add a composite uniqueness target or equivalent database guard to the existing `documents` table, plus server-side household authorization on every read/write. A document from another family must never be attachable by guessed ID.
4. Indexes for `(care_profile_id, care_day)` on approved placements and notes support backward traversal. Unreviewed placements and notes remain visible only to their permitted author/reviewers, never in ordinary family or MCP history reads.

No existing table needs to be dropped. Existing `source_objects` and `documents` continue to preserve original bytes, hashes and upload timestamps. Existing accepted evidence remains separate from the new day placement layer; it is not silently backfilled into day nodes based on uncertain dates.

## Read contract

- `list_timeline_days`: grouped populated days, newest first, with bounded file/note counts and continuation.
- `get_history_through_day`: selected day inclusive, then earlier populated days; optional focus-range start; fresh approved data and provenance on every request. The client may traverse all pages.
- `get_approved_source_page`: bounded text from one approved document page, with source hash, page number, offset and an untrusted-content label. If text does not exist, the original remains available only through an authorized viewer path.

The Express HTTP and MCP adapters must share the same application service and a household-scoped repository. A secure production implementation still needs session/OAuth authorization, CSRF for writes, immutable object handling, audit, scan/parse isolation and the hosted encryption boundary. The current TypeScript code is a tested contract, not that complete implementation.

## Approval boundary

After approval to **create** an additive migration, write the exact SQL and tests for the placement/note tables and cross-profile guards. Show the SQL and a data-preservation plan. Applying it to any existing database requires a **separate explicit approval**. Do not backfill, cut over writes, commit, push or deploy as part of the migration review.
