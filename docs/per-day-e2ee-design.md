# Per-day encryption and access: proposed managed design

Status: **design proposal, not implemented or approved for migration**. It records
the requirement implied by family-controlled E2EE plus private per-day grants.
Do not enable managed startup or use real records on the strength of this file.

The isolated browser prototype `web/src/crypto/dayKeyEnvelope.ts` now generates a
random day key and recipient-specific X25519/HKDF-SHA256/AES-256-GCM HPKE envelopes over
opaque IDs. It is not wired to hosted routes, persistence, grants, or the
recovery kit. It does not authenticate who issued an envelope; the recipient's
public key must come from a separately approved, authenticated enrollment flow.
The current record-blob format also lacks the full profile/day/epoch binding
and durable nonce reservation required for real-record use.

## Why the current schema and key are insufficient

The current browser vault prototype encrypts with one household key. The v5
managed schema can wrap one household key epoch for a device, but has no day-key
envelopes or per-day device grants. Giving a limited member that key would let
them decrypt every day, regardless of server-side permissions. The v6/v7 day
grant tables are for the trusted-server plaintext pilot; they do not repair this
cryptographic boundary. Records encrypted under a shared key cannot become
private from an existing key holder merely by adding a grant table later.

## Required key and metadata domains

- An owner/admin-only recovery root unlocks the family's per-day key envelopes.
  Ordinary limited members never receive this root. Recovery must restore it on
  a fresh authorized device without sending the code or raw key to the host.
  Recovery of keys alone does not prove the host served the latest manifest.
- Each populated care day has a fresh, random content key and a random opaque
  day ID. An admin gives a member only the envelopes for days they may read.
  A day key is not a whole-source key: a source spanning restricted days needs
  independently authorized source access or day-scoped encrypted excerpts.
- Undated drafts and private review material use a separate key domain. A day
  reader must not gain access to unapproved submissions by holding a day key.
- Care dates, document dates, filenames, notes, citations, and the mapping from
  dates to opaque day IDs stay in authenticated ciphertext. The server may see
  opaque IDs, device/grant records, sizes, upload times, and access patterns;
  it must not sort or filter the timeline by a plaintext care date.
- Key envelopes bind the format, household, opaque profile/day or source ID,
  key epoch, purpose, and recipient device. The server verifies member/session,
  device, and current grant before returning an envelope or ciphertext. A
  device verifies the envelope and signed manifest before decrypting.

## Write and read sequence

1. An authorized browser creates a random day key, encrypts a complete day
   snapshot locally, and prepares recipient-specific key envelopes. No clinical
   text or care date appears in the upload URL, headers, database row, or logs.
2. A transaction checks the writer's current session, active device, grant,
   expected revision, nonce reservation, ciphertext hashes, and manifest head.
   It publishes the opaque revision and envelopes together or not at all.
3. On every read, the server rechecks current grants for the day, source, and
   historical revision. The browser verifies the key-authenticated revision
   chain and a previously trusted head checkpoint, decrypts authorized entries,
   and computes the inclusive backward care-day view locally. A brand-new or
   last-device-loss recovery has no such checkpoint: an independent authenticated
   latest-head witness or a tested equivalent remains unresolved and blocks
   real-record launch. An old but valid signed manifest must not be accepted as
   current merely because its chain verifies.
4. A date correction is a reviewed revision of the affected encrypted day(s),
   not a server-side date update. Moving material between grant scopes needs
   explicit access review and key re-encryption.

Revocation stops **future** envelope and ciphertext access and requires key
rotation for new material. It cannot erase keys or plaintext already downloaded
by a former member. The UI must say this plainly.

## Additive schema work requiring separate approval

The next migration must define opaque day identity, append-only day revisions,
per-device day/source envelopes, grant/revocation events, nonce uniqueness for
every AES-GCM key—including owner wrapping, day/source content, recovery, and
manifest keys—scoped by actual key identity and epoch across writers/revisions,
and a compare-and-swap signed manifest head. Foreign keys
and triggers must prevent cross-household/profile/device references and
nonsequential revisions. Care dates and clinical labels must have **no**
plaintext columns. A migration must not auto-run against family or production
databases; first apply it only to a fresh fictional test database after explicit
maintainer approval. Existing v5 ciphertext rows and trusted-server v7 rows
need a separately approved migration/reencryption and rollback plan.

## Binary tests before real intake

- Two fictional households, two adults and a child: disjoint day/source grants,
  no hidden-day counts/cursors, cross-family denial, immediate server revocation,
  and the honest limitation for previously downloaded keys.
- Wrong household, profile, day ID, purpose, epoch, recipient, revision, IV,
  tag, chunk order, or predecessor hash fails without partial plaintext.
- Duplicate `(key identity, nonce)` for a content or wrapping key, stale revision,
  replayed older manifest (including on a fresh recovery device), missing envelope,
  incomplete multi-object write, crash/restart, backup/restore, and orphan
  reconciliation fail closed or recover to one verified state.
- A late upload about an earlier care day appears on a fresh backward read;
  upload time never becomes the care day. Multiple sources on one day, one
  undated source, a multi-day source, and a reviewed date move retain versions.
- Browser, API, MCP, object files, database, backups, logs, and errors contain
  no fictional medical marker, filename, care date, or unwrapped key outside
  the authorized browser. Cloud MCP remains non-medical until a verified
  device-held decryption path and visible per-client consent exist.

Independent security review of the implemented key sharing, recovery, nonce,
manifest, and access paths remains a real-record launch gate.
