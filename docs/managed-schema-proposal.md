# Hosted E2EE schema proposal — review before migration

Status: **partial implementation, updated 2026-09-26**. The maintainer authorized
creation of the managed migration files and separately approved one application
to a new disposable fictional local database. The first identity/grant draft is
[`0001_identity_scopes.sql`](../server/migrations/managed/0001_identity_scopes.sql).
The second
[`0002_ciphertext_intake.sql`](../server/migrations/managed/0002_ciphertext_intake.sql)
draft adds session-bound upload intents, key-identity nonce reservations,
chunk metadata with opaque private-storage object IDs, and immutable committed
ciphertext objects. A committed object is not a published timeline revision.
The third
[`0003_day_revisions.sql`](../server/migrations/managed/0003_day_revisions.sql)
draft adds append-only day snapshot revisions, session-bound adult publish
authority and compare-and-swap heads. The fourth
[`0004_staging_leases.sql`](../server/migrations/managed/0004_staging_leases.sql)
draft adds one pre-write lease per day upload intent. The fifth
[`0005_non_day_intake.sql`](../server/migrations/managed/0005_non_day_intake.sql)
draft adds separate source/draft ciphertext identity, nonce/object claims,
pre-write leases and a signed two-blob pending-draft pair registration. It does not
relax day-revision checks. The sixth
[`0006_active_scope_keys.sql`](../server/migrations/managed/0006_active_scope_keys.sql)
draft adds owner-signed monotonic current-key heads and guards both write paths;
it never guesses an active key from an existing maximum epoch. The seventh,
[`0007_scope_key_envelopes_v2.sql`](../server/migrations/managed/0007_scope_key_envelopes_v2.sql)
draft stores a fixed purpose-bound v2 envelope with active-key, current-grant,
recipient and owner-action references while closing new v1 issuance. None of
these migrations is registered
with the production startup path or applied to any non-fictional database. An explicit
fictional-only runner pins their SHA-256 checksums and creates a fresh private
temporary database only after a separate approval flag; it ran once with
specific approval on 2026-09-26.
That runner requires a source checkout containing `server/migrations/managed/`;
it is compiled only by the explicit `build:fictional-schema` target, not by
the ordinary server/Docker build (the regular typecheck still checks its source).
It refuses to run when `NODE_ENV=production` or any `RAILWAY_*` variable is
present. If failure occurs after a temporary directory is created, that private
directory is retained and reported for inspection rather than deleted.

The chunk schema now records the opaque storage object ID returned by the
existing private chunk writer. The streaming parser supplies the digest of the
exact received wire bytes to an unmounted staging adapter. That adapter writes
private chunks, re-reads each object through the commit-proof helper, checks
the complete wire digest, and converts SHA-256 hex to 32-byte database values.
An unmounted managed ledger now drafts an atomic current-grant/session/nonce
commit and per-family lease quota, but it has not run against an applied schema;
there is no reconciler for orphaned objects or safe retry path. The draft remains
day-only; `0005` has no mounted non-day ledger or intent-issuance API. A ciphertext-only snapshot primitive can copy and re-hash an exact list
of committed object references without scanning pending files; it publishes a
completed snapshot only after staged files and its read-only manifest are synced.
Failures before rename leave private, unpublished in-progress directories; a
failure syncing the parent after rename can leave a complete directory that
must be inspected before retry. Snapshot IDs are create-only reservations; a
failed attempt uses a fresh ID rather than reusing the previous one. No consistent
database-snapshot provider or full backup encryption/retention is implemented.
A separate, unmounted restore primitive can verify the pinned object manifest
and copy those ciphertext objects with their original IDs into a newly created
private, offline root. It publishes that root only after its objects are
re-read and a synced completion marker is linked. That is **not** a usable
fresh-instance restore until the matching DB
snapshot, keys, grants, checkpoint freshness and startup checks are restored
and verified together. Callers may mount only after successful return and
separate startup verification. An interrupted `pending-restore-*` directory
must not be mounted even if a marker was linked before the crash; a failure
syncing the parent after rename may leave a complete `restored-*` directory
that requires inspection before reuse. A process with the same storage UID can
still alter local files, so backup/restore roots require offline operator control.
Therefore no managed upload or read route may be enabled yet.
Do not apply these drafts to an existing, family, or production database. The first
execution target, if separately approved, is a fresh database containing only
wholly fictional families.

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
| `managed_scope_envelopes`, `managed_scope_envelopes_v2` | Recipient-device- and scope-bound ciphertext envelopes, key identity/epoch, purpose, issuer action and grant-head reference. ADKY v1 is day-only and new v1 issuance closes under draft `0007`. The 240-byte v2 wire purpose-binds day/source/draft/index and includes a key-material commitment, but SQL cannot calculate the wire or enrolled-device-key SHA-256. Runtime must verify both and the exact owner-signed canonical payload before insert; a structurally valid HPKE envelope is never proof of an approved grant. |
| `managed_owner_recovery` | Versioned encrypted owner-root envelope with signed provenance and recovery epoch. Never returned to ordinary limited members. Neither a server reset nor recovery code alone grants owner status. |
| `managed_upload_intents` | Short-lived, one-use intent reserved by the server for exact `(household, profile, scope, purpose, key identity/epoch, blob ID, expected revision, writer device)`. The URL's blob ID is checked against this row, never accepted as authority. Failed and expired intents cannot publish. |
| `managed_nonce_reservations` | Unique `(household, key domain, actual key identity, epoch, 96-bit nonce)` across every **application-managed AES-GCM** use with that key: content chunks, encrypted indexes/manifests, recovery and any direct key wrapping. A purpose/scope field supports audit but is not the uniqueness boundary. Reservation and blob publication are one transaction. HPKE's internal nonce/sequence rules need separate protocol validation; do not pretend an application IV table proves HPKE safety. |
| `managed_blob_chunks`, `managed_committed_blobs` | Staged private object IDs, exact v2 wire version, chunk order/size/IV/hash, verified ciphertext root and intent FK. A committed row appears only after exact EOF, all expected chunks, grant/session/nonce recheck and immutable object publication. Backups select committed references, never directory globs or pending aliases. |
| `managed_scope_revisions`, `managed_review_events` | Append-only revision number, predecessor hash, ciphertext blob/root, author signature and review state. A child submission is a review-draft revision; only an authorized adult can publish a new approved day/source revision. Stale compare-and-swap writes, forks and nonsequential revisions fail. Old revisions remain accessible only while the reader retains the relevant current grant. Client code must verify complete decrypted snapshot contents; SQL cannot infer what the ciphertext means. |
| `managed_index_heads`, `managed_device_checkpoints` | Signed compare-and-swap head per encrypted, member-appropriate index view, with sequence, predecessor hash and ciphertext reference. A limited member must not learn hidden-day counts through a global index, cursor or error. Devices verify the chain and retain a trusted checkpoint locally. |
| `managed_audit_events`, `managed_retention_events` | Content-free actor/action/opaque target/outcome and signed deletion/tombstone events. No filenames, care dates, document text, key material or request bodies in logs. |

The additive `0005` nonce-claim table currently unifies **upload-content**
nonces across the day and source/draft paths. Encrypted-index, recovery or
direct key-wrapping uses are not yet connected to that registry; they must use
separate keys or join the claim protocol before any managed client is enabled.
The new source/draft object ID is unique within its scope, but the existing
day-intent schema does not store an object ID, so this is not a cross-lineage
object-ID uniqueness claim. A pending draft pair is not adult approval. Neither
day and non-day intents now have signed-current-key checks in the `0006`
draft, but key rotation is not operational until the schema is tested,
canonical signatures are verified in runtime, and a current head is activated
for each scope. A draft must obtain both intents and open both
staging leases atomically under one combined quota decision before writing
either object. A sequential content-then-metadata lease request is not a
supported protocol; no batch issuer/stager exists yet.

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

1. Create the independent forward-only managed schema migrations under the
   maintainer's 2026-09-25 approval. Apply them only after separate approval,
   initially to a new private test database with two invented families. Never
   auto-apply them to community, Hermes, Railway, or real-family data.
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

## Approval boundary

The maintainer approved **creation** of the necessary migration files on
2026-09-25 and separately approved applying `0001`–`0010` to one new disposable
fictional local DB on 2026-09-26. That application passed schema integrity,
foreign-key and focused two-family binding checks. It does not cover any
other existing database, real case
data, production deployment, billing, a new external witness service, or a
pull-request merge.

Draft `0009` adds a one-use, short-lived Ed25519 challenge and immutable
one-device-per-session binding. Its composite foreign keys prevent a session
from being bound to a device owned by another account in the same household.
An unmounted enrollment candidate now precedes this binding: it issues a
session-bound X25519 ephemeral challenge, stores only a hash of a derived
nonce, verifies that the proposed encryption private key can derive that nonce
and that the proposed Ed25519 signing key signs both public keys and the
configured origin, then creates a **pending** device in one transaction.
It does not activate the device. A reauthenticated human/family approval path,
durable private-key storage, recovery and mounted route controls remain open.
SQL cannot validate the signature: the unmounted candidate service now drafts
verification of the enrolled key, session, device, nonce and configured
deployment audience, followed by consume-and-bind in one write transaction.
Invalid signatures are checked before taking the SQLite writer lock, then the
same challenge, enrolled signing key and live session/device are rechecked
under `BEGIN IMMEDIATE`; one session may issue at most 16 challenges. This
cap bounds per-session accumulation, but broader login abuse, retention and
rate limiting still need a mounted-route and operations design.
The candidate service now exposes only strict JSON-safe v1 challenge/proof
objects; the browser derives the signature audience from its own origin.
The browser tolerates 60 seconds of clock skew when deciding whether to sign;
the server's database clock and one-use challenge state remain authoritative.
Mounted routes must redact nonce/proof bodies from logs and errors and never
accept a cookie digest from a request field.
It passed a sequential replay denial against that migrated fictional database;
simultaneous race tests have not run.
The envelope reader has been narrowed to the bound device, but remains
unmounted. A stolen cookie after binding can still expose
ciphertext and access metadata; per-request proof remains a separate launch
decision. Every future mounted writer and upload-intent path must require the
same bound device; guarding this reader alone is insufficient. Candidate
ordinary/historical envelope writers and the day-upload ledger now require
the bound device in their authorization queries. Remaining managed paths and
insert triggers do not yet enforce this invariant outside the `0010`-covered
paths. No managed draft has been applied to a non-fictional database.

Draft `0010` adds insert-time session-bound issuer checks for both v2 envelope
tables and the day upload intent, lease and committed blob. It is defense in
depth alongside the unmounted TypeScript writer and ledger checks, not proof
that any row is valid ciphertext or that every managed path is session-bound.
Non-day/draft, active-key, day-revision and grant paths remain to be reviewed.
Like `0009`, `0010` has only been applied to the approved disposable fictional
local database; its day-intent bound-writer guard was exercised there. The
other insert guards and positive authorized write flows remain untested.
This lineage is new-only: the runner creates a fresh empty managed database and
does not migrate a database that already contains pre-binding v2 envelopes.
Such a database must be rejected, not silently made unreadable or backfilled
with invented device proof.
