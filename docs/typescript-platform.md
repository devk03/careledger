# Adeno TypeScript platform architecture

Target architecture, updated 2026-09-24. This is not a claim that the hosted family product or the TypeScript server is production-ready. The [all-TypeScript family pilot plan](all-typescript-family-pilot.md) now controls the private cutover. The [day-by-day product contract](treatment-timeline-product.md) controls the data model. The existing Python app remains operational during development but will not serve family records in that pilot.

## Decision

- Keep the current React/TypeScript/Vite app. Add TanStack Router for navigation and TanStack Query for ordinary server state incrementally; do not rewrite the existing UI just to change libraries.
- Build an Express/TypeScript backend beside the current Python service. Move a capability to Express only after its auth, storage, safety and test parity is demonstrated. Never have both runtimes write the same clinical tables independently.
- Keep wire-level timeline types in the local `packages/contracts` TypeScript package, consumed by both `server/` and `web/`. Authorization and repository interfaces remain server-only; the frontend maps contract data into display components without inventing care events.
- Make Adeno a source-preserving data service, not an agent. No hosted agent memory, model-driven research, vector search, treatment recommendations or precomputed consensus in the core path.
- Treat deterministic file intake and manual day placement as the required path. OCR, model extraction and per-day summaries are optional later processes. If a caregiver opts into a model with their own key, a summary may be recomputed after a day write, but it is derived, versioned and never required for read-time history or treated as the source of truth.
- Put one permission-checked timeline application service behind both REST and read-only MCP adapters. MCP tools expose bounded, cited records to the caregiver's chosen agent; they do not expose SQL, arbitrary filesystem paths or unreviewed drafts.
- Preserve the existing immutable object store and audit trail. A new TypeScript persistence adapter must be scoped by household and care profile in each query, not only at the route layer.

## Core object and chronology

The visible unit is a **sparse calendar-day node**, keyed by `(care_profile_id, YYYY-MM-DD)`. No empty day row is pre-created. Once a day has published material, each published change stores an immutable complete snapshot of its content references; current access is controlled by [per-day and source grants](day-access-and-history.md). A node can link multiple original files and notes; a file may link to more than one day if it discusses multiple dates. No material for a date means “nothing recorded in Adeno for that day,” not “no care occurred.” Unknown or conflicting care dates remain in a review queue; the upload timestamp is never substituted for a care day. The older [additive storage proposal](day-storage-design.md) is incomplete for the pilot and must not be registered as-is.

Keep distinct fields for clinical/care day, document date, report finalization date, received-at timestamp and review time. Originals and their hashes are immutable. Corrections are versioned; they do not overwrite prior reviewed content. Source-linked statements retain a document ID and page or a named family attribution. An approved record is an editorially checked record, not a medical validation.

## Query-time context

`getHistoryThroughDay(profile, day)` checks the authenticated family scope, reads the **currently approved** populated days at or before the selected day in reverse date order, and returns bounded pages with source references. An optional `focusFromDay` marks a requested date range while still including earlier context. Each request goes back to durable storage; Adeno does not persist an AI-generated summary or consensus. A continuation cursor lets a client traverse all earlier days without dropping history to fit one tool response. If a file is later added to an earlier day and approved, the next query includes it automatically.

Label this “currently recorded history through [day].” It is not a reconstruction of what the family knew on that historical day; that would also require an upload/review-time cutoff. Long-form explanation and synthesis belong to the user's chosen agent, subject to the client's own privacy terms. The server returns records and provenance, not medical advice.

TanStack Query may keep short-lived in-browser server state for navigation, but clinical history requests must revalidate after a write and on entry. It must never be treated as the authoritative or persisted context cache. Express responses containing health information use `Cache-Control: no-store`.

## Boundaries

```text
web/ React + TanStack Router/Query + Vite
       ^ shared wire types from packages/contracts/
       |
       v
server/http/ Express transport -> session/CSRF authorization
       |
       v
server/timeline/ application service -> household-scoped repository
       |                                  -> immutable object metadata/content
       v
server/mcp/ read-only tools over the same service (later)
```

The first TypeScript package in `server/` has a pure backward-history service, injected Express read routes, and in-memory-tested MCP tools for sparse days and bounded approved source-page text. The repository read contract now carries the authenticated user ID as well as household and profile so a future durable adapter can enforce day/source grants; the adapter does not exist yet. A fictional vertical-slice test compares HTTP and MCP responses before and after a later upload is attached to an earlier care day, and checks cross-family denial. Preliminary upload admission validates size, signature, claimed MIME type, display name and hash; a separate helper can write exact original bytes once to a private quarantine directory. Neither helper promotes a file or replaces the current malware scan and isolated PDF/image inspection. The package has no production authentication, persistence adapter, upload route, public MCP transport or deployment entrypoint. Those omissions are intentional fail-closed boundaries, not finished features.

Production authorization must preserve the current secure cookie, hashed session tokens, CSRF binding, Origin checks, audit behavior and per-document access checks until replaced by proven TypeScript equivalents. A TypeScript module now checks cookie tokens, expiry/revocation/auth-version state, Origin/Fetch-Site and session-bound CSRF; a read-only adapter verifies the v5 schema before looking up sessions. These are unserved components, **not** a production login or write-authorization flow. Every write must recheck the session and CSRF inside the same SQLite transaction as its mutation. Never accept a model-supplied household/user ID as authority. Cross-family reads should return the same not-found response as an unknown profile. MCP authorization is a separate, short-lived, scoped connection grant; linking a client alone must not bypass family-controlled encryption.

## Migration sequence and gate

1. Land shared TypeScript contracts and query-time traversal tests with fictional repositories.
2. Add Express routes behind injected auth and storage interfaces; keep them unserved publicly until the real adapters pass parity/security tests.
3. Add TanStack incrementally to the existing Vite app and build a day-card UI against the typed route.
4. Design additive document-day placements and notes with cross-profile database guards. **Ask before creating or applying any migration.** Keep the Python app as the sole writer until the TypeScript write path is proven.
5. Add read-only MCP tools over the same application service and test a supported local client; no generic query or agent memory.
6. Replace Python features one bounded capability at a time, with existing data preserved and rollback possible. Hosted family-controlled encryption and cloud MCP plaintext sharing remain separate launch gates.

Verification for the first vertical slice: TypeScript typecheck/build; unit tests for sparse days, inclusive cutoff, a later upload attached to an earlier day, pagination and source references; HTTP tests for authentication and cross-family denial; frontend tests using wholly fictional files; and a real local upload/history walk after the persistence migration is separately approved.
