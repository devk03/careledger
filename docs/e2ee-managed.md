# Managed edition: end-to-end encryption boundary

Direction reaffirmed 2026-09-22: the maintainer chose to retain family-controlled encryption even if this delays private-record access from cloud-hosted MCP clients. See the [MCP-first product plan](mcp-first-product.md) for the local-companion prototype and the unresolved web-client boundary.

Historical product update (2026-09-07): hosted use and optional self-hosting were planned with operator-managed inference. The [MCP-first plan](mcp-first-product.md) now makes a caregiver's compatible AI client the primary conversation surface. The caregiver-owned OAuth and separate hosting-fee approach below remains an earlier implementation proposal; do not treat it as a requirement for caregivers to open a provider API account. The E2EE boundary in this file remains binding.

Adeno has one open-source codebase with two operating modes:

- **Community:** a caregiver runs Adeno on a computer or server they control and may
  configure a local model or their own provider credential.
- **Managed:** Adeno hosts only encrypted vault objects and non-medical account/billing
  metadata. In normal operation, record plaintext and vault keys remain on caregiver devices.

Managed mode currently fails startup on purpose. It must remain unavailable until the
ciphertext-only server routes and the browser setup, recovery, sync, consent, and inference flow
are integrated and pass every launch blocker below. The cryptographic modules alone are not a
managed product.

The current one-household-key browser prototype and v5 managed schema do **not**
provide private per-day grants: a member given that key could decrypt denied
days. The [per-day design proposal](per-day-e2ee-design.md) describes the
owner-only root, separate day/source keys, opaque encrypted date index, and
schema/security work required before limited-member sharing. Do not wrap the
current household key to an ordinary limited member or claim that server-side
day grants provide E2EE isolation.

An optional `createSyntheticVaultCanaryApp` is exercised only by server tests. It moves
fictional encrypted bytes over HTTP into a bounded, in-memory two-household store with
cookie/CSRF checks, then returns those exact bytes. It has no durable adapter, day grants,
backup, browser UI, or runtime entrypoint; `NODE_ENV=test` is required to instantiate it.
It demonstrates honest-client transfer and some authorization failure behavior, **not** a
guarantee that the server can detect a malicious client sending plaintext in a fake envelope.
One fictional integration test uses the actual browser vault encoder and decoder across this
test-only HTTP boundary; it still does not exercise a deployable managed route or durable store.
Separately, a Chromium test verifies browser-side encryption, wire round-trip, a non-exportable
key, and rejection of a changed revision; it does not exercise hosted upload or recovery.
An exact-length recovery-envelope wire format can carry the wrapped key without its caregiver-held
code. A fictional two-browser test opens an encrypted record after transferring the code and
envelope to a fresh browser context. This is not yet a downloadable recovery kit, vault backup,
hosted sync, or multi-caregiver key-sharing flow.
It must not be used for real records or described as hosted E2EE readiness.

The unmounted `stageVaultWireStream` parser accepts the browser's full 100 MiB
wire format across variable boundaries of source fragments up to 1 MiB, with
total fragment-count and empty-fragment caps, without copying the whole body.
A future HTTP adapter must split or reject larger upstream buffers and enforce
a deadline.
It checks framing and requires a staging sink to abort failed uploads and publish
only after exact EOF. It does **not** authenticate AES-GCM, prove that a client
actually encrypted its bytes, authorize a member, enforce grants, or durably store
an object. A production route still needs a deadline, request-abort handling,
transactional staged storage, device authorization, and independent review.

An isolated filesystem primitive now writes one already-produced ciphertext chunk
to a private, create-only, household-separated opaque path and verifies its hash,
size, and read-only mode on read. It deliberately does not deduplicate by content
across families. A successful write intentionally retains a read-only `pending-*`
hard-link alias to the same inode. Future backups must select authorized database
rows and final object IDs, never glob this directory; alias inventory and orphan
reconciliation are still required. Mode `0400` does not protect against a process
that controls the storage UID, so this is not host-level immutability.
It is not connected to an HTTP route or database transaction; it cannot establish
who may read a chunk, whether the bytes are genuinely encrypted, which care day
they belong to, or whether an orphaned file is part of a committed backup.

A separate v2 browser blob primitive binds encrypted chunks to opaque household,
profile, day/source/draft scope, object, epoch, purpose, revision and chunk
position. The shared v2 wire format has no care dates or labels and is rejected
by the legacy v1 decoder. An unmounted Express upload boundary now requires an
authenticated session, same-origin CSRF, an opaque upload intent that reserves
the exact blob ID and scope, v2 framing, and a store callback whose commit must
atomically recheck grants and nonce reservations. Its timer bounds incoming
bytes only; future session, intent and storage operations need their own
cooperative deadlines. Fictional HTTP tests cover the seam; an unmounted
durable-ledger draft exists but has not run against an applied managed schema.
There is still no route in the running app. It is not connected to real grants, nonce reservation, signed
manifests, backup or MCP. V1 ciphertext is never treated as a per-day private
record.

The browser can now prepare a **local-only** encrypted review draft from a PDF,
JPEG, PNG or family note. It encrypts the original bytes and a separate metadata
object containing the filename or author, a client-side selection timestamp and
explicit candidate care days. An empty day list stays undated; selection time is
never promoted to care time or labeled as server receipt time. This preparer
requires two distinct server-reserved blob IDs **before** encryption so its
AES-GCM AAD and v2 wire headers can match later upload intents. There is no
managed draft-intent issuer yet. The preparer does not upload, save, scan,
classify, authorize, recover or publish anything.
It needs a future distinct review-draft key and enrolled reviewer devices;
using an approved day key for drafts would violate draft isolation. The
production caller must supply a browser `File` snapshot rather than a mutable
custom file-like object; bytes are copied after read and their digest is stored
inside encrypted metadata. The browser test uses only fictional content and checks that no record upload or
plaintext request occurs.

The browser also has a fictional signed-index-head prototype. Ed25519 signs a
canonical opaque header binding a member-specific view to an encrypted-index
ciphertext hash and prior head. A device with an already trusted checkpoint
can reject a changed or skipped head, but this does not establish the newest
head for a fresh device, authenticate enrollment by itself, or prove the index
decrypted and contained every authorized day. Neither a durable checkpoint nor
an independent freshness witness is implemented.

The browser-only `managed/timeline.ts` view projects already-decrypted, approved
entries into sparse care days and a separate approved-undated queue; pending
submissions still need a separate review inbox. Its backward query
filters by care day, not upload time, and never invents a source-download link.
Continuation carries a client-local fingerprint derived from the same copied
approved-entry snapshot returned on that page; if a later read changes, the
reader must restart rather than silently missing a newly updated day.
The fingerprint is not a hosted URL or server cursor and does not prevent a
server from replaying an older intact encrypted manifest.
This is not an authorization boundary, encrypted index, revision store, or hosted
timeline endpoint: current grants must be enforced before entries reach it.
The existing plaintext `@adeno/contracts` timeline and `/api/v2` history remain
community/local-pilot interfaces and must not become managed E2EE wire types.

The managed service must not call server-side storage encryption "end-to-end encryption."
Client-side encryption requires the browser to encrypt before upload and decrypt after download.
The database and object-storage service must be unable to recover a document, filename, patient
name, timeline, question, AI draft, accepted claim, or local search index.

A web client is still code delivered by the service operator. A malicious or compelled operator
could serve altered JavaScript that reads an unlocked vault. The managed web edition therefore
protects against database/object-storage compromise and an honest-but-curious server; it must not
claim protection from a malicious serving origin. That stronger promise requires an independently
installed, signed client with reproducible builds, verified updates, and key continuity.

## Managed data path

1. The current prototype generates a random 256-bit household data-encryption
   key. This is not the final limited-member key hierarchy; the proposed
   managed design keeps an owner/admin recovery root separate from random
   per-day and per-source content keys.
2. Originals and structured state in the prototype are split into bounded chunks and encrypted with AES-256-GCM.
   Every chunk receives a fresh 96-bit IV and authenticated scope containing the format, random
   immutable blob ID, household, opaque object ID, revision, chunk position, and total plaintext
   length.
3. The server stores ciphertext, IVs, opaque IDs, sizes, and sync versions. It never receives the
   unwrapped household key or medical plaintext.
   E2EE does not conceal exact file length, chunk count, upload timing, or access patterns from
   the host; the UI and privacy notice must disclose these metadata leaks. Padding is a separate
   design choice, not a protection in the current vault wire format.
4. Browser-side processing renders and extracts records in an isolated worker. Search and review
   use a local decrypted index rather than a server-side medical index.
5. Current recovery wrapping protects one household key only. Before launch,
   recovery must restore the owner root and every authorized day/source key
   through authenticated envelopes. Losing every authorized device and the
   recovery secret will mean the server cannot recover the vault; the UI must
   explain this before setup.

Multi-caregiver sharing and rollback-resistant version manifests are also design-only. Sharing
must wrap only approved day/source keys to a limited caregiver device, never the
owner root. A key-authenticated
version chain must prevent the server from replaying an older intact vault. Both designs require
independent security review before invitations or managed sync are enabled.
A recovered device without a prior trusted head cannot detect a replayed older
but valid manifest from the host on its own; an independently authenticated
latest-head mechanism is still an unresolved launch blocker.

## AI exception, stated plainly

When a caregiver presses **Explain this record**, the browser must show the exact pages selected,
the model/provider, and the external-transfer notice. After confirmation, the browser decrypts
only those pages and sends them directly to the caregiver's OpenRouter account. The Adeno
server does not proxy or log the request and owns no inference credential.

OpenRouter and its selected model provider necessarily receive the approved pages for that
request. Adeno therefore promises client-side encrypted storage, not secrecy from an AI
provider the caregiver explicitly chooses. Requests must enforce ZDR routing, deny data
collection, disable response caching, web search, tools, and provider-policy overrides, and keep
all returned drafts untrusted until caregiver approval.

## Nontechnical experience

The managed UI uses three plain-language actions:

1. **Protect my records** — creates the vault and a printable recovery kit.
2. **Turn on explanations** — opens OpenRouter sign-in and returns without asking the caregiver to
   copy an API key or choose a model.
3. **Explain this record** — shows the pages leaving the device and the expected cost band, then
   reports the exact provider charge after completion.

Terms such as API key, PKCE, AES-GCM, routing, and tokens belong in an optional technical details
panel, not the primary flow.

## Break-even, not profit

Adeno should not resell inference in the first managed release. OpenRouter OAuth lets the
caregiver fund their own account, so Adeno adds no inference markup and cannot receive an AI
bill. A separate, plainly labeled annual managed-hosting fee should cover only compute, encrypted
storage, backups, support tooling, payment fees, taxes, and a small operational reserve. Publish
the cost formula and review it annually.

Microcharging each inference through Adeno would introduce card fees, refunds, tax, failed
payments, credit accounting, and fraud exposure. It is less transparent and can make a zero-markup
project lose money. If unified billing is added later, use prepaid credits and a metering service,
and charge payment/tax costs explicitly rather than hiding them in model prices.

## Launch blockers

- No managed endpoint may accept medical plaintext or an unwrapped vault key.
- Browser and end-to-end tests must prove uploads, downloads, backups, logs, analytics, and error
  reports contain ciphertext only.
- Changing tenant, object, revision, chunk order, IV, ciphertext, or authentication tag must fail
  closed without returning partial plaintext.
- The browser must call OpenRouter directly; the Adeno origin must have no inference key or
  proxy route.
- Recovery, key rotation, rollback detection, adding/removing a caregiver device, deletion, and
  encrypted export must be implemented, independently reviewed, and tested.
- Content Security Policy, dependency pinning, signed releases, and rapid XSS response are part of
  the E2EE threat model because served JavaScript can access an unlocked vault.
