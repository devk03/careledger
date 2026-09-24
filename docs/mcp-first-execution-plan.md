# Treatment timeline execution plan

**Product focus, 2026-09-23:** [The day-by-day treatment timeline](treatment-timeline-product.md) is the canonical product object. The inbox and MCP tools exist to create, correct or query that timeline. Build manual source-linked day cards and read-time backward traversal first; no model classification, agent search or stored consensus is required for core use. Keep documented plans distinct from completed care.

Branch: `feature/mcp-first-platform`, created from the local `main` commit `ad357da` on 2026-09-23. This repository has no `master` branch; the separate private parent workspace does. The branch carries existing uncommitted product and lowercase-brand changes. No parent case file belongs in this repository. No commit, push, deployment or migration is authorized by this plan.

## Outcome

An adult can sign into their own adeno account, add several treatment-related records and a rough note, correct and approve source-linked day entries, see what changed in the timeline, and ask their compatible agent about that approved history. Another adult in the same family gets their own access and tasks. A separate family cannot read any of it. Hosted storage remains family-controlled and ciphertext-only; private data is never exposed through a hosted MCP tool without a validated device-side sharing path.

## What exists today

- Community app: one owner login, single-file PDF/photo upload, source hashing/quarantine, optional proposed evidence extraction, accept/reject review, accepted-claim search, and a simple date-sorted dashboard.
- Not ready: multi-file inbox, durable rough notes, OCR/page rendering, document classification, editable day placement, approved versioned family updates, individual family accounts, inbound MCP OAuth, an MCP server, and managed E2EE integration. The `managed` edition deliberately fails startup.
- Browser vault and recovery cryptography plus managed sync tables are foundations, not a complete private hosted flow. Current community record storage is server-readable.

## Work packages, in order

| Package | Deliverable | Evidence that it works |
| --- | --- | --- |
| 0. Protect the baseline | Keep synthetic-only fixtures, existing community flow, manual CI, and the managed startup guard. Document separate local and hosted privacy behavior. | Tests and scans contain no real records or keys; the existing Docker app still uploads, reviews, searches and exports safely. |
| 1. Inbox vertical slice | Batch PDF/photo drop and rough-note entry; resumable per-item statuses; duplicates and failures visible. Original preserved; upload time separate from any clinical date. Start with fictional data and current community mode. | Browser and API tests cover mixed batches, reload/restart, bad files, duplicates, partial failure, and 320px mobile layout. No control pretends to save when it cannot. |
| 2. Manual timeline | An editor creates or corrects source-linked day cards without AI, attaching multiple files/notes to one day and keeping planned versus occurred statements and care day versus document/upload dates distinct. Add an undated queue and “what changed” view. | Corrected day cards retain old revision and actor; page citations resolve; upload time never silently becomes a care day; approved web timeline and bounded search agree. |
| 3. Read and classify | Isolated embedded-text extraction, page rendering, OCR fallback, legibility flags and source-grounded document type/date/day-placement extraction. Show source beside editable extracted entries; accept/reject/correct into the existing timeline. Use authorized-device processing for the managed design. | Text PDF, scanned image, unreadable page, wrong-patient match, unknown/partial/conflicting dates, and prompt-like text all remain unverified until review. No care advice or AI-created clinical tasks. |
| 4. Local MCP proof | A small read-only companion over approved synthetic data: connection profile, day entries with source files, backward history through a selected day, latest approved update, my tasks, bounded cited evidence search. No generic database, upload, approval or publish tool. | MCP Inspector and one real local client initialize, list tools and answer a synthetic question; a day cutoff excludes later care days; unapproved data and oversized responses fail closed. |
| 5. Individual family access | Separate adult accounts and admin/editor/member roles; all members can submit into a review queue, while only editors approve nodes. Include invitation/recipient binding, approved-versus-draft visibility, task ownership, per-request authorization, device enrollment and recovery design. | Two adults in one family see appropriate views; a third adult in another family cannot retrieve data by direct URL, search or MCP; revocation and role downgrade take effect on the next request. |
| 6. Family-controlled encryption | Encrypt records, derived text, timeline, drafts and search data before hosted upload. Separate keys for approved material and editor drafts; per-device envelopes, recovery, rotation and rollback resistance. | Hosted server receives only ciphertext and permitted metadata; tamper/restore/recovery tests pass; independent security review; managed guard remains until the complete flow is proven. |
| 7. Copy-and-connect | Signed-in person copies one public, non-secret instruction; agent adds adeno; browser OAuth approval selects family and scopes; profile tool verifies the connection; disconnect revokes it. Private-record access is a separately tested device-side step. | A nontechnical tester completes a supported client in under two minutes without pasting a key or using a terminal; wrong account, expired token, revoked member and incompatible client produce clear states. |
| 8. Small hosted pilot | Validate actual client-specific private sharing, encrypted backup/recovery, retention/deletion, audit, bounded processing costs and support runbooks using only authorized pilot data. | No health-data MCP tool is enabled on a cloud client until its plaintext path and provider disclosure pass review; cross-family and ciphertext-only tests pass end to end. |

Packages 1–4 can be demonstrated locally with wholly fictional data. Packages 5–8 are required before claiming a secure family-hosted product. Work may be parallelized behind stable interfaces, but the privacy and authorization gates cannot be bypassed to make a demo look complete.

## First branch slice

1. Write the synthetic acceptance story: two fictional adults, two files and a note attached to one documented treatment day, a separate result with a different finalization date, an uncertain planned day, and one correction. Do not derive it from a real case.
2. Specify source/day-entry/update states and date rules. Create day cards only for dates with material; a missing card means no information recorded for that date, not that no care occurred. One day card may hold multiple files and notes; do not introduce nested event objects or an hour-by-hour view. Build a manual source-linked timeline and “what changed” view in the isolated preview before adding document extraction. Keep real save actions disabled there and label that mode plainly.
3. Reuse community upload and evidence services for a single-file persisted vertical slice; define additive persistence changes separately before implementation. Then add batch intake and a durable rough note.
4. Implement a local read-only MCP protocol proof using only synthetic approved timeline objects and `get_connection_profile`. Verify initialization and tool discovery with an inspector and a supported local client.
5. Run current lint/type/unit/browser checks and targeted security tests for the new behavior. Stop optional testing once the new slice is verified.

This slice intentionally does not request or use a provider key, touch real patient documents, enable hosted E2EE mode, or expose a public MCP endpoint. It creates a testable path toward the full loop rather than claiming the full loop already works.

## Approval and release gates

- **Database checkpoint:** before any new tables or migration files for notes, day entries, memberships, update versions, grants or key envelopes, present the exact schema and data-preservation plan to the maintainer and obtain explicit permission to create/apply migrations. Do not alter the existing community database just to prototype UI.
- **Privacy checkpoint:** decide and verify how each supported agent receives a user's selected plaintext while the hosted server remains unable to decrypt it. A local desktop companion is the first target; cloud clients need separate proof. OAuth connection alone is not private-record access.
- **Access checkpoint:** never use a model-provided family/user ID as authority. Intersect active membership, role, client grant and available content key on every request. A single shared key cannot keep working drafts private from ordinary members.
- **Publication checkpoint:** review the exact staged diff and synthetic assets for PHI/secrets before any commit or push. CI remains manual. Do not deploy or publish based on a visual preview.

Out of this plan's first build: WhatsApp/email reminders, calendar sync, donations/payment UI, broad disease research, child-specific views, unrestricted raw-document MCP tools, and universal cloud-agent support.
