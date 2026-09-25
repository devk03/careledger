# Hosted E2EE schema proposal — review before migration

Status: **proposal only, 2026-09-25**. This document is not a migration or
approval to create one. No SQL in this proposal may be applied to an existing,
family, or production database. The first implementation target, if separately
approved, is a fresh database containing only wholly fictional families.

## Why this is a separate schema line

The community schema has a one-household `singleton = 1` constraint and stores
care-profile names, document names/dates, and extracted page text in plaintext
(`0001_initial.sql`). Its v5 managed tables are preliminary: grants and key
envelopes are household-wide, nonce uniqueness is keyed by household epoch, and
blob uploads require format v1 (`0005_managed_e2ee_sync.sql`). The v6/v7
care-day pilot is explicitly trusted-server plaintext, including day dates and
note bodies. Python registers through v5; the separate TypeScript pilot expects
v7. Applying v6/v7 and then treating the database as hosted E2EE would break
the product's privacy boundary.

Therefore the proposed hosted store starts a **new, independently versioned
managed database**. The existing community and trusted-local databases remain
unchanged. No automatic migration or dual-writer cutover is part of the first
schema test. Any import of existing records requires a separate, user-approved
client-side reencryption and rollback plan.

## Server-visible and encrypted fields

Every household, profile, device, scope, blob and intent ID is independently
random, fixed-width and opaque. The server may see account identifiers, member
roles, device keys, grant relationships, scope **kind**, ciphertext lengths,
upload timestamps and access patterns. It must not store care dates, document
dates, file names, note bodies, claims, extracted text, page citations, profile
names, or the mapping from a care date to an opaque day ID in plaintext. Those
belong in authenticated ciphertext. A server timestamp means **received at**;
it never becomes a care day. Login/contact details are operational PII and need
their own notice and retention policy, not an E2EE claim.

## Proposed relational contract

Names below are provisional; the invariants are not. All clinical relations
carry a composite household key. Cross-household references fail by foreign key
and by application authorization. Immutable history tables reject UPDATE and
DELETE except through an explicit, audited retention workflow. All protected
writes check current session, device, grant, expected revision and relevant
signatures **inside the same transaction**.

| Entity | Required opaque fields and invariant |
| --- | --- |
| `managed_families`, `managed_members`, `managed_sessions`, `managed_invites` | Multiple households per database. Hashed login/session/invite tokens; one-use expiring invitations; member status and auth version. No patient or clinical label. A disabled member or changed auth version invalidates sessions on the next request. |
| `managed_profiles` | `(household_id, opaque_profile_id)` only, plus lifecycle state and an encrypted display-metadata reference. No preferred name or birth date column. |
| `managed_devices`, `managed_enrollment_challenges` | Device belongs to one active member; authenticated X25519 encryption and Ed25519 signing public keys, proof-of-possession, one-use session-bound challenge, activation/revocation events. Enrollment checks active member/session and challenge expiry inside one transaction. A public key supplied by an agent or model is never automatically trusted. |
| `managed_scopes` | `(household_id, opaque_profile_id, scope_id, kind)` where kind is day, source, review draft, or encrypted index. No calendar-date column. A source spanning several days remains a separately granted source scope; a day key cannot unlock it by implication. |
| `managed_key_identities` | One random key identity and epoch per scope/purpose. The host stores a commitment and signed registration, never key material. Reusing the same underlying AES key under a new claimed ID cannot be detected by SQL alone and must be prevented by client key lifecycle and review. |
| `managed_grant_events`, `managed_grant_heads` | Append-only signed grant/revoke events for each `(household, profile, scope, subject/device)` stream. An event carries the **complete capability set** (view, contribute, publish, or none), not one independently ordered capability bit. It signs a monotonic stream sequence, predecessor hash and expected head, plus issuer identity/counter. One transaction checks issuer authority and advances that stream's head by compare-and-swap; if two authorized issuers conflict, one must retry after reading the winning event. The current grant comes only from the verified head, never arrival time or incomparable per-issuer counters. Issuer counters are also strictly monotonic. Pending/revoked devices cannot receive envelopes. Clients check the chain against a trusted checkpoint; a newly recovered client still needs the independent freshness witness below. |
| `managed_scope_envelopes` | Recipient-device- and scope-bound ciphertext envelope, key identity/epoch, purpose, issuer device, signature, and grant-event reference. The current ADKY v1 wire covers **day-content** only; source and draft envelope formats must be purpose-bound and reviewed before they can be inserted. A structurally valid envelope is not proof of an approved grant. |
| `managed_owner_recovery` | Versioned encrypted owner-root envelope with signed provenance and recovery epoch. Never returned to ordinary limited members. Neither a server reset nor recovery code alone grants owner status. |
| `managed_upload_intents` | Short-lived, one-use intent reserved by the server for exact `(household, profile, scope, purpose, key identity/epoch, blob ID, expected revision, writer device)`. The URL's blob ID is checked against this row, never accepted as authority. Failed and expired intents cannot publish. |
| `managed_nonce_reservations` | Unique `(household, key domain, actual key identity, epoch, 96-bit nonce)` across every **application-managed AES-GCM** use with that key: content chunks, encrypted indexes/manifests, recovery and any direct key wrapping. A purpose/scope field supports audit but is not the uniqueness boundary. Reservation and blob publication are one transaction. HPKE's internal nonce/sequence rules need separate protocol validation; do not pretend an application IV table proves HPKE safety. |
| `managed_blob_chunks`, `managed_committed_blobs` | Staged private object IDs, exact v2 wire version, chunk order/size/IV/hash, verified ciphertext root and intent FK. A committed row appears only after exact EOF, all expected chunks, grant/session/nonce recheck and immutable object publication. Backups select committed references, never directory globs or pending aliases. |
| `managed_scope_revisions`, `managed_review_events` | Append-only revision number, predecessor hash, ciphertext blob/root, author signature and review state. A child submission is a review-draft revision; only an authorized adult can publish a new approved day/source revision. Stale compare-and-swap writes, forks and nonsequential revisions fail. Old revisions remain accessible only while the reader retains the relevant current grant. Client code must verify complete decrypted snapshot contents; SQL cannot infer what the ciphertext means. |
| `managed_index_heads`, `managed_device_checkpoints` | Signed compare-and-swap head per encrypted, member-appropriate index view, with sequence, predecessor hash and ciphertext reference. A limited member must not learn hidden-day counts through a global index, cursor or error. Devices verify the chain and retain a trusted checkpoint locally. |
| `managed_audit_events`, `managed_retention_events` | Content-free actor/action/opaque target/outcome and signed deletion/tombstone events. No filenames, care dates, document text, key material or request bodies in logs. |

The file/object store and SQLite cannot commit atomically together. Stage private
objects first; publish database references only after validation and fsync;
reconcile unreferenced staged objects after a crash. A backup contains only
database-referenced ciphertext, envelopes, signatures and recovery metadata,
with verified hashes and a tested fresh restore.

## Boundaries the database cannot solve

- It cannot tell whether a malicious client sent true ciphertext in a valid v2
  frame, whether two claimed key IDs hide the same underlying key, or whether
  a submitted signature/hash actually matches its public key/object bytes.
- It cannot stop a former member from reading plaintext or keys already copied
  before revocation. Rotate keys for future material and explain this limit.
- A signed manifest chain plus a server-stored head does **not** prove freshness
  to a new or fully recovered device: the host can replay an older intact
  database. An independently authenticated latest-head witness or tested
  equivalent remains a real-record launch blocker and may need separate
  service/cost approval.
- The same rollback problem applies to a grant/revocation head. SQL ordering
  prevents concurrent writes from forking a live database, but cannot prove to
  a recovered client that the host has shown the latest grant state.
- A cloud MCP server cannot decrypt records under the family-controlled promise.
  Private-agent access needs a validated device-held sharing path and visible
  consent for exactly what plaintext leaves that device.
- The operator serves browser JavaScript; a malicious/compelled serving origin
  could alter it. Do not claim protection from that threat without a separately
  installed, signed client and reproducible update path.

## Fictional migration and acceptance sequence

1. After explicit permission, create an independent forward-only managed schema
   migration and apply it only to a new private test database with two invented
   families. Never auto-apply it to community, Hermes, Railway, or real-family data.
2. Assert no clinical plaintext columns; inspect every table, index, trigger,
   route, log and backup for a fictional name, care date, file name, note and key.
3. Prove cross-family/profile/device FK rejection; invalid or stale sessions;
   ungranted, revoked and wrong-scope reads; hidden-day count/cursor denial;
   wrong/expired/replayed intent; duplicate `(key identity, nonce)`; v1/v2
   downgrade denial; concurrent nonce reservation with exactly one winner;
   nonsequential/stale/forked revision; signer-counter replay; concurrent
   conflicting grant issuers (exactly one CAS winner), stale grant-head replay;
   invalid reviewer; and
   immutable history on UPDATE/DELETE.
4. Exercise two files on one encrypted day, an undated draft, a multi-day source,
   a late earlier-day upload, correction history and inclusive backward reads
   from the authorized browser. No upload timestamp may become a care date.
5. Kill the process during staged upload and publish; restart and prove one
   verified state. Backup and restore to a fresh instance, then compare all
   committed ciphertext digests and the independently witnessed latest head.
6. Only after separate approval and independent security review, plan a
   production cutover with write freeze, verified backup, rollback procedure,
   Railway secrets/volume and one TypeScript writer. A schema test is not
   permission to enable managed startup or accept real records.

## Approval requested

Permission sought is limited to **creating and applying the initial managed
schema migration in a fresh fictional local database**. It does not cover an
existing database, real case data, production deployment, billing, a new
external witness service, or a pull-request merge.
