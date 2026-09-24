# All-TypeScript private family pilot

Decision recorded 2026-09-24: the family pilot will use the React/Vite frontend and an Express/TypeScript runtime as the **only** application writer. The existing Python app remains available during development but will not be the deployed family-record service. This is a cutover plan, not a claim that the TypeScript service is ready. Hermes is a trusted, server-readable host for this pilot; it is **not** family-controlled E2EE.

## Current boundary

The Dockerfile still starts Python, and Compose defines only that service. The TypeScript server has tested in-memory HTTP/MCP read paths and preliminary upload admission/staging, but no production entrypoint, sessions, durable repository, upload route, review workflow, or public MCP transport. The existing SQLite schema is version 5. The unregistered `0006_sparse_care_days.sql` draft is paired with an unregistered `0007_family_day_access.sql` follow-on for per-day grants, snapshots, and the child-review outbox. They have been applied together only to fresh fictional test databases. They must not be registered for startup or used with family records until the TypeScript authorization and write path pass the release gates.

Do not run independent Python and TypeScript writers against one medical database. Until cutover, Python remains the sole writer. The TypeScript service may read synthetic fixtures during development, but no real records go into a new pilot until the gates below pass.

## Critical path

1. **Identity and authorization.** Implement TypeScript owner setup, separate adult/child accounts, expiring single-use invitations, password/recovery flow, server-side sessions, secure cookie, CSRF and Origin checks, throttling, revocation, and an append-only audit. Every protected query includes the authenticated user ID, household, care profile, and the required day/source capability. No user-provided ID or agent argument is authority. Default is no day grant.
2. **Durable records and day state.** Build the SQLite adapter, immutable source-object store, safe upload route and parser/scan boundary. Add manual care-day placement, undated queue, family notes, per-day grants, and complete immutable snapshots on every published change. Child submissions stay pending until an authorized adult publishes them. A write compares the version the editor saw and rejects stale updates. Query-time backward history reads only currently authorized, published days.
3. **Review inbox and one agent connection.** Keep a durable adult review queue and read-only MCP tools over the same scoped service used by the web UI. A generic queue count or change hint contains no child text. An adult approves in the browser, not through the agent. First verify one compatible client end to end; do not promise that every cloud client can wake while offline.
4. **TypeScript runtime and cutover.** Add an Express entrypoint, readiness probe that checks schema/storage/integrity, graceful shutdown, one-replica Docker image and Compose service with a persistent volume. Cut over with a write freeze, drained jobs, a verified encrypted backup, the separately approved migration applied once, and the Python process stopped. Do not start both runtimes as writers. Rollback needs a tested backup/restore path, not a downgrade SQL script.
5. **Hermes private pilot.** Install the container runtime, use its existing Nginx for TLS, bind Adeno to loopback, configure an exact public origin, disable public signup and optional AI initially, limit administrative access, and keep an encrypted off-host backup. Only a fictional-data smoke test goes through Hermes before real family records. No public hosted intake or E2EE claim.

## Release acceptance, with wholly fictional data

- An admin invites two adults and a child; each has a separate login. Reused or expired invitations fail, and revocation ends sessions and agent grants.
- The admin grants different days to each adult. A user cannot infer hidden days from counts, cursors, direct URLs, source links, search, exports, or MCP. Full source access has its own grant.
- Two files attach to one day; another day remains separate; upload time is not used as care day. A child proposal changes no published snapshot. An adult approval creates one new snapshot; previous versions and authorship remain visible to permitted readers.
- Concurrent stale edits fail without replacing the newer snapshot. Agent and web history agree after a late upload to an earlier day. The adult agent can discover a pending review without receiving the child's content automatically.
- Restart/rebuild retains records. Auth, CSRF, upload limits, content isolation, backup/export, restore, readiness, and shutdown pass on the production image. A revoked member immediately loses current and historical access.

Public source code may continue to ship on a feature branch during development. Do not merge a release or expose real family uploads until these gates pass and the maintainer explicitly authorizes the deployment.
