# Hermes private MVP

Target origin: `https://adeno.kunjadia.dev`. This is a trusted, server-readable
private deployment, with public signup and invitations disabled. It makes no
managed E2EE claim. Do not import real case records into the repository.

## Family controls and record dates

The workspace now shows visible person buttons and an inline Add person form.
The active person is named beside uploads and approved history; switching people
clears the previous source, proposals, uploads and date cutoff. Adding a person
creates a record space, not an invitation or access grant. Duplicate names are
caught in the form before a second space is created.

A visible introduction and expandable explanation describe the implemented value:
separate histories, preserved source images/fingerprints, care dates distinct from
upload time, and review before assistant access. No diagnosis or generic connector
performance claim is made. Upload timestamps render in the browser's local zone
while retaining the exact UTC value. Valid date-prefixed filenames suggest a care
day only; invalid dates stay blank and all suggestions require source review.
Recognizable PDF page-copy filenames show an explicit notice that the fingerprint
belongs to the uploaded image, not the original PDF. Native PDF intake stays closed.

## Guided workspace and assistant setup

The private workspace now explains account/person separation and the sequence
of adding a person, uploading/reviewing records and connecting Codex. It hides
the empty profile selector and places person setup beside assistant setup.
Primary actions use the existing filled Coral style; supporting instructions,
readable spacing and compact consent controls replace the undifferentiated form.

Existing active approvals automatically expose **Copy setup instruction**, with
explicit instructions to paste into Codex on the same Mac and verify the account
and care profiles. SSH arguments stay inside manual/technical details. Native
clipboard failure opens a selectable fallback. Expired approval cannot be copied;
an unknown creation outcome blocks blind retries until access is checked. Access
approval is never labeled a verified connection. Disconnect revokes every active
approval shown by the account inventory. Provider disclosure and server-side
consent/CSRF/revocation remain intact; no schema or permissions were changed.

Eighteen focused component tests and three Chrome browser scenarios passed,
including native clipboard transfer, reuse of existing approval, profile
creation, 20px consent geometry, source-image rendering and 320/375/414/768/1280px
layout checks. Axe found no serious/critical issues. Frontend build and scoped
lint passed. The broader frontend run had 175 passes and one pre-existing
managed-device expiry assertion failure: it expects a one-second-expired
challenge to fail, while unchanged code allows 60 seconds of clock skew.
That managed-device code is outside this private runtime and was not changed.

Release `dc1624b` is deployed on Hermes, manifest
`sha256:5c1688fc951df8eb8726f2a9d57ff3cae61182f5d530e2acf3dd89ef4edac4c8`.
The previous environment is retained in `release.before-dc1624b.env`. HTTPS
serves the redesigned bundle, readiness passes and owner setup remains complete.
Actual signed-in Chrome inspection confirmed automatic reuse of the existing
approval, the prominent copy button and hidden technical details. The unfinished
person-name field was preserved across reload without submitting it. No account,
record, grant or schema mutation was performed during that browser check.

## Initial public activation, October 14 evening Pacific

Cloudflare is authoritative for `kunjadia.dev`; Squarespace is only the registrar.
The user authorized dashboard access. The new DNS-only A record
`adeno.kunjadia.dev → 68.183.163.198` was saved and publicly resolved. Existing
records were preserved. Let's Encrypt issued a valid hostname certificate,
expiring January 13, 2027 UTC. The tested Nginx configuration is installed;
HTTPS `/pilot` returned 200 with successful certificate verification.

The production Compose services started with the approved data root. A one-off,
network-disabled probe mounted only the production worker sockets and confirmed
PNG/JPEG decoding, malformed-image/PDF denial, source-bound rendition and real
antivirus detection using independently generated pixels and the inert EICAR
test string. It read no database or record directory. A bounded official
signature updater reported all three signature databases current and exited 0.

The host's existing Certbot timer (active since July) is preserved. The new
`reload-adeno-private` deploy hook applies only to this certificate lineage,
validates Nginx and reloads within a 60-second bound. Its successful path was
tested. No new monitoring schedule was installed.

Live browser inspection caught the missing private runtime mode endpoint: the
global banner fell back to the fictional-only preview warning. The fix reports
the explicit trusted-private mode, preserves server-readable disclosure, and
links a private-specific privacy page covering AI disclosure, permissions,
preserved originals, current image/PDF support, retention and backup limits.
Server/browser builds, 15 focused UI tests and lint passed. Owner account setup
and actual Codex application acceptance remain human steps; no password has
been entered by the agent.

The corrected release `d87761d` is now deployed as `adeno-private:d87761d`,
manifest `sha256:58fd316f2b948e5b91f9867e934faf1860161026e8d4c3bc2b896a67baab5263`.
The prior release environment is retained as `release.before-d87761d.env`; no
schema change was needed. Actual HTTPS requests verified trusted-private mode,
the private privacy route, readiness, no-store/CSP/nosniff headers, unauthenticated
session/profile/intake denial and disabled invitations. Chrome showed the
corrected server-readable banner and navigated to the private privacy page.
Owner setup remains ready in the live browser. The setup token was copied only
to a private local handoff file outside Git, never printed in chat/tool output.
The owner must enter their own new password and submit setup. Production record
review and actual Codex application acceptance remain incomplete until that
human setup and approval are finished.

## Production preparation, October 14

The user separately approved migrations 0001–0007 for the new empty production
database `/home/devkunjadia/adeno/private-mvp-20261014/case.sqlite`. They were
applied once in an isolated, network-disabled `adeno-private:008d50f` container,
in one transaction with independently calculated ledger hashes. The production
schema verifier, integrity/FK checks and empty audit-chain verification passed.
Households, users, sessions, profiles, documents and audit events are all empty.
The directory is 0700 and database 0600, both UID/GID 10001. The retained schema
initializer container is
`9b4e5427bd9a1c667fa93acc5853facafb86db844cab407b6af486f2db7a20a1`,
exited 0 without OOM. No existing database was modified.

Dedicated production socket volumes `adeno-private-parser-socket-v1` and
`adeno-private-scanner-socket-v1` have owner/group 10002:10003 and 10004:10005,
respectively, with directory mode 0710. Their initializer exited 0; no production
worker was started. These are separate from all synthetic socket volumes.

The private operator configuration is
`/home/devkunjadia/adeno/production-20261014/release.env`, mode 0600 under a 0700
directory. Compose configuration was parsed with project `adeno-private-mvp`,
both private pilot/record files from release `008d50fd8057b1b73587edb85dac38f0aae2eb26`,
the approved production data root and dedicated volumes. It pins app `008d50f`,
parser `bd86dc3`, scanner `a021cd0`, a 512 MiB storage quota and the existing
official signature volume `adeno-signatures-20261014`. Application access remains
loopback-only and workers have no network. Enabling the verified agent/record
flags is now supported by the synthetic integration evidence below.

`deploy/nginx/adeno-private.conf` is prepared but not installed. Its configuration
passed Hermes Nginx 1.24's `-t` check in an isolated config using a private test
certificate; this does not establish real certificate readiness. It disables
access/error request logging and upstream request/response disk buffering, and
limits uploads to 30 MiB. No Nginx configuration was reloaded or site enabled.

Activation still requires the user's deferred DNS change, a valid hostname
certificate, a fresh-signature check (run a bounded updater if needed), owner
setup and actual browser/Codex acceptance. Do not initialize the time-limited
bootstrap token until the owner is ready. No account, password, record or
bootstrap token has been seeded. No production service is running. The private
test certificate remains outside Git and must never serve the public hostname.

## October 14 synthetic integration result

The user approved existing migrations 0001–0007 for new synthetic test databases.
The full server suite passed 348 tests (three Linux-only cases skipped on macOS).
The pending-note fixture needed an explicit child intake grant before insertion;
the database's denial was correct and no schema change was required.

On Hermes, `adeno-private:008d50f` with the real parser `bd86dc3` and scanner
`a021cd0` passed the HTTP upload, proposed document-day exclusion, explicit
publication, note review, cited original-hash verification, app restart,
session persistence, fresh sign-in and logout-denial scenarios. Public signup
and invitation routes returned 404. The isolated data root was
`/home/devkunjadia/adeno/synthetic-20261014-0902`, never production storage.
`server/test/createPrivateSyntheticDatabase.mjs` requires explicit approval opt-in
and refuses existing directories; `privateRuntimeScenario.mjs` requires its
synthetic marker. All requests use independently invented data. The first run's
script failures (missing worker health-socket setting, note response envelope,
and startup readiness race) were corrected without product changes; prior data
and containers remain retained.

The SDK scenario `privateRuntimeMcpScenario.mjs` connected through real SSH stdio,
read the database-authorized history and source image, verified original and
rendition hashes, denied an outside profile, then observed denial on the same
connection after HTTP disconnect. This remains SDK integration evidence; actual
Codex application acceptance and human browser review remain outstanding.
All app/parser/scanner containers were explicitly stopped and inspected with no
OOM. They also had 15-minute lifetime bounds. No recurring monitor was started.

An offline synthetic snapshot was encrypted on Hermes using only the public age
recipient. Its 1,074,575-byte ciphertext was copied off-host and checked against
the pinned SHA-256 `1ff8de4d7e7bb1e120678224c003b565c542177edb9fd524cb44da784f997c57`.
The private identity stayed off-host. Restore CLI verification passed, followed
by independent checks of approved revision 2, the source citation/hash, decoded
240×160 original pixels and zero active sessions. Recovery artifacts remain in
private storage outside Git. This proves the synthetic generation, not future
production backups. Production database approval, HTTPS/DNS and actual client
acceptance are still required. Historical verification limits below describe
the state at their respective commits.

The candidate entrypoint is `server/src/runPrivatePilot.ts`. It requires an
existing private v7 database and never initializes or migrates one. The
container binds to Hermes loopback port 8091 through Compose; Nginx supplies
HTTPS on the exact configured origin. Existing sites must remain intact.

## Operator preparation

1. Point the hostname's A record to Hermes (`68.183.163.198`). Verify DNS before
   issuing a certificate or publishing a connection instruction.
2. Obtain separate migration approval for the exact new database and schema.
   Use a new private synthetic database first. Preserve existing databases.
3. Prepare the data directory with mode 0700, owned by container UID/GID 10001;
   the database and sidecars must have mode 0600. Keep it outside the checkout.
4. Set `ADENO_RELEASE_TAG` to the reviewed image tag and
   `ADENO_PRIVATE_DATA_DIR` to that absolute directory. Do not place secrets in
   Compose, Git, screenshots or shell command arguments.
5. Build with `docker compose -f compose.private-pilot.yaml build`. Startup is
   unavailable until the approved database exists. The private bootstrap token
   is stored under `/data/secrets/bootstrap-token`, never in container logs.

## Current verification limits

The private note-review API returns a proposed note only to an authorized adult
reviewer, with the current day revision for stale-edit protection. Ordinary
history and MCP do not return proposals. HTTP tests cover authentication,
generic denial, freshness and uncached responses. SQLite permission tests need
separate approval to apply existing migrations to synthetic test databases.

Feature commit `16f6cba` built on Hermes into `adeno-private:16f6cba`, image
manifest `sha256:cbb5dbd7754770592ffc4a7a220d357ac6c4bb554a7ab5261a00de5c0cde7673`.
A network-disabled, read-only, non-root container loaded SQLite and verified a
synthetic Argon2 hash. This proves native runtime compatibility, not app startup.

The `/pilot` UI now implements the v2 login/setup, note-proposal and explicit
review APIs, using the existing component library. UI tests verify password POST
handling and publication only after reviewing the actual proposal with its
observed day revision. Profile creation now has an owner-only transactional
writer, Origin/session/CSRF preflight route and UI form. HTTP/UI tests cover
request boundaries and selecting the newly created profile. Database-backed
ownership, audit and revocation assertions await migration approval.
The UI can traverse earlier days, select an inclusive care-day cutoff, and open
bounded source text with document/page IDs and the original hash. Source text
is rendered as text; cursor validation rejects skipped or repeated sections.
The private runtime applies a self-only CSP, disallows framing/objects, and
suppresses referrers. UI tests cover pagination, provenance and literal rendering
of synthetic script-like text. Durable file intake remains work.

`createTrustedIntake` now joins permission preflight, capacity admission, exact
private staging, required scanner/parser clearance, immutable object publication
and a final transactional metadata boundary. Synthetic tests exercise actual
filesystem staging/storage with test scanner/parser doubles, including revocation,
unavailable scanning, capacity denial and caller mutation. They do not prove
production decoding/scanning. PDFs remain rejected. This service is not mounted;
real Hermes adapters and database-backed verification remain prerequisites to
enabling uploads. The candidate SQLite writer now rechecks intake/session/CSRF
inside its metadata transaction, records a one-page inspected image as
`needs_review`, deduplicates within the authorized profile and appends an audit
event. It does not create or approve a care day. Its database regression test is
written but has not run because migration approval is pending.

The physical-capacity policy counts both staging and object roots, including
abandoned files, and counts hard-link aliases once. It rejects unsafe permissions,
symlinks, missing roots, excess entry/depth traversal, exhausted configured
capacity and insufficient filesystem free space. Focused filesystem tests pass.

The candidate HTTP intake router performs Origin/cookie/CSRF and intake-right
checks before buffering one bounded binary request. It rejects PDFs, compression
and malformed filename headers, preserves exact bytes and returns generic
pipeline errors. HTTP tests cover permission denial, byte/name transfer,
concurrent-request exclusion and slot release after failure. It is not yet
mounted in the private runtime.

`runSyntheticImageProbe.ts` generates its own PNG/JPEG bytes and checks the
actual parser socket, truncation denial and PDF rejection. The health probe runs
separately as the worker user, whose health socket is private. Neither accepts
source documents. Hermes verification must run with network disabled, private
socket-only mounts, non-root users and a worker lifetime under ten minutes.

On October 14, feature `9e3a0c8` built on Hermes into parser image
`sha256:6e20b632d535a0b7ad41a1e312b10bd17c208fbb70e9a23e52376dc9d4524bff`.
The worker's inspected configuration used UID/GID 10002:10003, no network,
read-only root, a 512 MiB memory limit and only a synthetic socket volume. It ran
under a 480-second lifetime with a 15-second forced-exit bound. Its private health
probe passed. A separate UID/GID 10001:10003 client, with the socket volume
read-only, generated PNG/JPEG bytes and received acceptance for both, rejection
for truncation and rejection for PDF. The client exited 0; after its identity,
image, synthetic label and mount were rechecked, the worker was stopped and
confirmed exited 143. Both stopped containers and the volume remain recoverable.
This is tiny-fixture target-host transport evidence, not a malware scan, resource
exhaustion test or production upload approval.

The private UI now discovers authenticated intake capabilities and keeps its
image picker disabled when intake is unavailable. It submits original file
bytes with CSRF/name headers, shows per-item results and stops a batch on an
unconfirmed response. Client and UI tests cover type/size rejection, exact file
transfer, server/network uncertainty and leaving later files unattempted.
No production upload route is enabled by this UI work.

The candidate authorized MCP adapter pins the browser-approved user/family and
reloads authorization before every repository operation and connection-profile
call. Tests deny revocation and identity switching on an already-open client and
redact storage errors. The profile states `trusted_server_readable` and that
selected results reach the AI client. An internal session-digest reader rechecks
expiry, revocation and account auth version; no digest is accepted as an HTTP
credential. Durable browser-approved grants and a real stdio/SSH launch remain
work. Nothing here enables a public MCP endpoint.

The candidate private agent-grant store binds a random connection ID to the
verified browser session's digest and identity for at most one hour. It contains
no password, plaintext session token or health record. Each use rechecks the
current session, expiry and immutable identity; disconnect writes a private,
durable revocation marker and preserves the original grant metadata. File reads
are bounded and deny symlinks/unsafe permissions. Issuance is serialized with a
512-entry cap. Filesystem tests cover these boundaries; browser approval,
database-backed identity and a real SSH/client setup are still unproven.

`runPrivateMcp.ts` is the candidate read-only stdio entrypoint for SSH. It
requires explicit transport opt-in, a strictly formatted grant ID, the private
runtime configuration, an existing compatible database and a live adult account.
It opens no network listener and issues no grants. Every read reloads grant/session
authorization; protocol input is capped at 256 KiB and process lifetime at one
hour. Startup failure writes one generic stderr line, never stdout credentials.
A real stdio SDK client passed initialization, cited synthetic history/source
reads and post-revocation denial using invented repository fixtures. CLI tests
deny malformed/missing arguments. These tests do not prove browser approval,
durable database authorization, Hermes SSH setup or actual Codex interoperability.
A second real-process test uses the actual private grant files and observes a
durable revocation marker written by another process context. Its session reader
is still a fictional repository double, so this is grant-file/stdio evidence,
not the missing SQLite/browser acceptance run.

The candidate browser agent router requires the exact history/source consent
revision, same-origin cookie/CSRF preflight and a current adult account derived
inside a database transaction. It rechecks identity after the private grant file
is written and revokes on a failed authority recheck. Disconnect is account-bound;
other users' connection IDs receive generic not-found. HTTP tests cover consent,
spoofed ownership, revocation during issuance and disconnect. The adult/session
SQLite regression is written but remains unrun pending migration approval.
These routes are not yet mounted in production.

The runtime can compose these routes only with
`ADENO_PRIVATE_AGENT_CONNECTIONS=verified`; the default is `disabled`, and this
flag must remain disabled until the database-backed approval checks pass. Compose
names the sole private runtime `adeno-private` for the supported SSH instruction.
The UI requires explicit read-only sharing consent, labels grant validity as an
approval rather than a verified connection, lists only the account's grants, and
provides a nonsecret setup instruction plus disconnect. It explains that the AI
client/provider receives selected plaintext and revocation cannot erase received
copies. UI tests cover disabled state, consent, credential-free instructions and
disconnect. It does not auto-configure or approve an assistant.

The candidate file-encryption layer uses the author's
[age TypeScript implementation](https://github.com/FiloSottile/typage), pinned at
`age-encryption@0.3.1`. It streams private files to an age recipient and publishes
restored plaintext only after complete stream authentication. Wrong identities,
modified/truncated ciphertext, unsafe permissions, symlinks and existing output
paths fail closed. Partial outputs remain private and recoverable; no files are
deleted. A production decryption identity must be generated and kept off-host.

On October 14, wholly synthetic 200,000-byte data encrypted here was decrypted
by Hermes's reference age CLI 1.1.1; CLI-encrypted data then restored here with an
exact-byte match. The probe's test identity was transferred only for that
fictional interoperability check and is not a production backup identity.
No real database or record was read. Off-host generation retention and full
application restore remain unverified.

Sharp is now pinned at 0.35.5 in both server and parser lockfiles, addressing
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
Focused image/parser tests pass and both production dependency audits report
zero vulnerabilities. On October 14, the patched parser from `023f7fc` built on
Hermes as image
`sha256:6f0791ddea30a438f632a60c9c66b2d4f55404c0371903ed15c2ca38cc00085b`.
A fresh non-root, network-disabled, read-only worker passed its control health
check and the generated PNG/JPEG acceptance, truncation denial and PDF denial
probe through its private socket. Its only persistent mount was a new synthetic
socket volume, with a 512 MiB cap and 480-second process lifetime. The client
exited 0. The exact worker identity/image/label/mount were rechecked before
stopping it; test containers and volume are retained. No database or source
record was mounted. Production scanner/intake and resource stress remain pending.

The private bundle codec uses fixed database/recovery/object member types rather
than archive-supplied paths. It verifies exact lengths and digests, rejects trailing
data, preserves existing destinations and writes restored files into a private
pending tree. Only a successful required application-state verifier permits
publication as `restore-root/data`; originals are restored read-only. Filesystem
tests use explicitly non-SQLite synthetic database bytes, so they prove archive
framing/path/digest behavior, not application restore or database compatibility.

The candidate offline snapshot collector copies an existing compatible v7
database through SQLite's backup API, bundles exactly its referenced originals
and recovery pepper, then encrypts to an off-host recipient. It requires stopped
writers and new output paths. Only the copied database has its sessions revoked;
the source database and originals are preserved. Agent approvals and bootstrap
tokens are excluded. Restoration checks the separately pinned ciphertext digest,
authenticated archive, schema/audit integrity, exact original inventory and
revoked sessions before publishing a new private data directory. Plaintext
working copies remain private and retained; operator cleanup is manual.
The synthetic database integration regression is written but remains unrun
pending permission to apply the existing migrations to new test databases.

HTTPS, connector setup, encrypted off-host backups, restore and deployed
acceptance remain unproven. DNS configuration is deferred to the maintainer for
October 15. This document is a runbook candidate, not a readiness claim.

The [isolated scanner candidate](private-scanner.md) now has target-host evidence:
official signatures were downloaded and load-tested by a finite updater, and a
separate network-disabled, non-root daemon accepted a generated PNG and detected
the inert EICAR test string through its private socket. The test worker was
stopped and its artifacts retained. This does not enable the production intake
route; freshness, peak resources and end-to-end database/publication checks
remain required.

The candidate writer now supports explicit document-day proposals and adult
accept/reject decisions. Proposal authority requires source/own-intake access
and day contribution or intake rights. Publication rechecks the session, adult
publisher, current source grant and expected day revision inside one immediate
transaction. Accepted placements create source-linked immutable snapshots while
preserving accepted notes; rejected proposals create no day. Duplicate pending
or accepted document/day placements are denied. No upload timestamp is used as
the care day. This is editorial placement approval, not clinical verification.
The synthetic SQLite regression covers hidden proposals, stale-edit rollback,
child denial, duplicate/repeated decisions, note preservation and revocation.
It is written but has not run because existing-migration approval remains
pending. These writer methods are not mounted as HTTP routes or usable UI yet.

The candidate document-day router now adds private proposal/review HTTP endpoints
and a scoped review-detail read. Cookie/Origin/CSRF preflight runs before bounded
JSON parsing for writes; strict bodies deny spoofed authority and invalid dates.
Storage failures return generic unavailable responses. The review-detail query
requires an active adult, current source access and day publication rights and
returns the observed day revision with source hash/page count. Ordinary history
and MCP still exclude proposals. HTTP regressions use independently invented
repository doubles; the SQLite read regression remains gated on migration
approval. The router is not mounted in the private production runtime yet.

The candidate private inbox returns up to 20 clean inspected records per page,
using upload-time/document-ID cursors for stable ties. It labels upload time
separately from proposed care days. Adult owners can see profile intake; current
contributors can see their own uploads. Proposal pointers are limited to their
author and adult owner. Scoped reads run inside one SQLite read transaction;
revoked intake permission removes contributor inbox access. The HTTP cursor gate
rejects partial, repeated and unsafe values. The synthetic SQLite pagination and
revocation test is written but remains unrun pending migration approval.
The browser API client encodes the profile/document/cursor fields, sends only
explicit care-day decisions with CSRF and the observed day revision, and marks
network failures, server failures and unparseable mutation replies as unconfirmed.
It never automatically retries a mutation. This client is not yet a complete
inbox/review interface or evidence of a deployed workflow.

The candidate original-image route provides a private review prerequisite. It
reads only a metadata-authorized PNG/JPEG hash from the immutable object tree,
checks private ownership/permissions, exact length, signature and digest, then
rechecks session identity and source authorization before returning bytes.
It applies no-store/nosniff/same-origin image headers, opens no arbitrary path
and holds one bounded original read at a time. PDFs are rejected. The repository
allows an adult owner, current source grantee or uploader with active intake
permission. This is a browser review route, not an MCP draft-read capability.
Filesystem/HTTP regressions use generated images; database permission coverage
and runtime mounting remain pending migration approval and integration.

The private UI now includes a capability-gated record inbox, explicit care-day
proposal, preserved-image review and adult accept/reject controls. Care day is
blank until selected, independent of upload time. Approval requires the exact
hash-pinned original to load and a human confirmation; a full-size source link
supports closer reading. Unconfirmed writes or stale conflicts clear the
old approval and require inbox refresh before another mutation. Signing out or
changing profiles unmounts private review state. Upload/publication refreshes
the inbox/history. UI tests cover confirmation, blank dates, uncertain writes
and disabled capability with synthetic responses; desktop/mobile renders use a
generated fictional image. The runtime
capability defaults to disabled, and no production document routes are mounted.

## Candidate record runtime composition

The entrypoint now composes upload, private originals, inbox and adult document
review only when `ADENO_PRIVATE_RECORDS=verified`. Base Compose explicitly sets
it to `disabled`. An opt-in composition is prepared in
`compose.private-records.yaml`; this is not an assertion that activation has
been approved or its database-backed acceptance checks passed.

The enabled runtime requires two distinct absolute Unix-socket paths. It derives
private `objects` and `quarantine` directories beside the existing database and
provisions them under the existing private application-owned parent. It never
creates, initializes or migrates a database. The same transactional writer is
used by note, grant, upload and document-review routes. The scanner requires
fresh loaded signatures on every scan, and the parser independently checks exact
bytes in its isolated worker. No unavailable scanner/parser verdict is clean.

The initial physical storage limit is 512 MiB across originals, retained staging
and orphans; a smaller explicit limit is allowed down to 64 MiB. Each admission
also preserves 512 MiB of filesystem free space. This private MVP limit is
intentional while the backup bundle has a 1 GiB bound. Capacity exhaustion denies
new uploads and preserves existing files. Operators must reconcile retained
stages/orphans manually; no background deletion or cleanup job is installed.

Before using the override:

1. Obtain approval to apply the existing migrations to synthetic test databases,
   run the complete v7 authorization/publication/restore tests, and resolve
   failures. Obtain separate approval for a new production database.
2. Build reviewed app/parser/scanner images. Set `ADENO_RELEASE_TAG`,
   `ADENO_PARSER_RELEASE_TAG` and `ADENO_SCANNER_RELEASE_TAG` to those exact tags.
3. Provision fresh private production socket volumes with the workers' intended
   ownership. Set `ADENO_PARSER_SOCKET_VOLUME` and `ADENO_SCANNER_SOCKET_VOLUME`.
   Do not reuse the retained synthetic test socket volumes.
4. Load/test official signatures with the bounded, once-only updater and set
   `ADENO_SIGNATURE_VOLUME`. The running scanner mounts signatures read-only,
   and both workers have networking disabled and no application-data mounts.
   Worker container logging is disabled so parser/scanner diagnostics cannot
   persist document-derived material. Use exit/resource metadata and generated
   probes for operator checks; do not replay real source bytes into debug logs.
5. Set `ADENO_PRIVATE_DATA_DIR` to the separately approved private data directory.
   The bind must already exist; Compose no longer creates a missing host path.
   Inspect the merge of the base and record override with Compose `config`
   before starting any services. The app gains only supplementary socket groups
   10003/10005 and read-only socket mounts; its database/data mount remains private.
6. Prove synthetic sign-in, upload, original viewing, proposal/review/publication,
   source citations, revocation, app restart and off-host restore in the composed
   runtime before real records are introduced. Check actual peak host resources.

The workers retry crash exits at most three times. A stale scanner socket fails
closed; verify the exact stopped worker and preserve/archive the stale socket
before manually restarting. Parser stale-socket recovery is independently tested.
For signature updates, stop the verified scanner, run the bounded updater against
its signature volume, require update/load-test success, preserve/archive any
stale socket, restart, then require real clean/detection/freshness probes.
No recurring updater or monitoring job is added by this composition. Readiness
currently describes the app/database; adapter failure is denied at intake and
must not be inferred from the app readiness endpoint alone.
The image has no recurring Docker healthcheck. Operator readiness/restart checks
must use a finite deadline under two hours; do not replace this with an unbounded
polling job or workflow.

On October 14, runtime composition commit `90f164a` passed server build/typecheck
and 34 focused configuration/intake/router tests. Read-only Compose validation
confirmed loopback binding, the existing-only data bind, isolated workers,
supplementary socket groups and disabled worker logs; it started no services.
Commit `4acfa13` also removed the inherited recurring Docker healthcheck.
That release built on Hermes as image
`sha256:a3cfdff4d067e3ece7d15989eef25b7558517c51c99155b0d639bb67d79c506e`.
A UID 10001 synthetic runtime probe with no network, read-only root and no mounts
passed an in-memory SQLite version read, synthetic Argon2 verification and an
ephemeral age roundtrip. Record and agent capabilities were disabled by default.
It exited 0 without OOM and remains stopped/recoverable. No schema, migration,
application startup or record workflow was exercised by this packaging check.

The [finite backup CLI and offline procedure](private-backup-operations.md) now
provide private JSON-configured key generation, snapshot and restore commands.
Server build/typecheck and twelve command/file-encryption/bundle/preflight tests
passed. The command tests create only independently invented files and test keys;
they apply no database migrations. An off-host identity and public-recipient
receipt have been provisioned on the maintainer's trusted device, outside Git;
the private identity has not been transferred to Hermes. No production database
snapshot, off-host record generation or full application restoration has run.

Source text reads now additionally require the document to appear in the latest
approved snapshot of a currently visible care day. A source grant by itself no
longer authorizes an unpublished intake document. The synthetic SQL regression
covers pre-publication denial, publication and source/day grant intersection;
it remains unrun pending migration approval.

A candidate worker-only image rendition helper prepares 1600-pixel JPEG evidence
for clients with bounded MCP responses. It fully validates/decodes the owned
original first, auto-orients, flattens on white, strips original metadata and
returns separate original/rendition digests. It preserves originals and performs
no transcription, diagnosis or inference. Generated-fixture tests cover geometry,
metadata/orientation, input ownership, digests and corrupt-source denial.
This helper is not yet connected to isolated subprocess transport or MCP; images
must not be rendered inside the HTTP/MCP process to bypass that pending boundary.
MCP repository calls also recheck their pinned authorization after a read
completes, withholding results if consent/session identity changed during the
operation. Server build/typecheck and 25 focused decoder/MCP/real-stdio tests
passed; those tests do not replace the pending v7 database permission checks.

The rendition helper now has a bounded subprocess entrypoint. Inspection retains
its 512-byte child reply limit; rendering permits at most 8 MiB plus a small
metadata envelope. The supervisor snapshots input before asynchronous checks,
uses a trusted executable file, sends only bytes/type/digest, ignores decoder
stderr, kills a stalled/cancelled child, and validates source binding, geometry,
canonical base64 and rendition digest before accepting output. It imports no
native decoder. Native decode/render runs only in the short-lived child, which
must still be launched by the isolated parser worker. Generated real-process
tests cover result tampering, caller mutation, corruption, deadline and abort.
The never-exit test fixture also has an independent one-minute safety deadline.
Parser-socket and MCP image integration remain unfinished and disabled.
Server typecheck/build and 30 focused decoder/process/parser tests passed after
this bridge change. A fresh supervisor-only process loaded its module without
Sharp/libvips native libraries. This is local IPC evidence, not target-host
image-rendering or database-backed source authorization acceptance.

The parser socket now recognizes an explicit rendition purpose while preserving
the ordinary 2 KiB inspection reply bound and existing inspection behavior. The
worker shares one bounded job slot across inspection/rendering and launches the
same trusted short-lived decoder child. The rendition client validates its
trusted socket, exact request envelope, frame length, input/output digests and
bounded result. Generated Unix-socket tests cover a response larger than the
inspection limit, corrupt input, unsafe directories, forged digests and oversized
declared frames. An approved-image repository query additionally requires source
permission plus current visible publication; own intake rights are insufficient.
Its SQL regression is written but remains gated on migration approval. No MCP
image tool or production activation is enabled by this socket work.

On October 14, `bd86dc3` built on Hermes as parser image
`sha256:69d37dcae23f5c370eaac57459cc6f25d0e574ab665cda9129b85a0a8f16bd03`.
A fresh UID/GID 10002:10003 worker had networking disabled, read-only root,
512 MiB memory cap, one synthetic socket volume and a 480-second lifetime bound.
Its control health check passed. A separate network-disabled UID/GID
10001:10003 client generated an image and confirmed a source-bound rendition
larger than the inspection reply limit plus corruption denial. Another generated
probe confirmed PNG/JPEG acceptance and truncated-image/PDF denial. Both clients
exited 0 without OOM. The exact worker identity/image/label/mount were rechecked
before stopping it; containers and volume are retained. No database or records
were mounted. This proves target-host decoder transport for generated inputs,
not database authorization, MCP/client integration or the full deployed workflow.

The private MCP composition now optionally exposes `get_approved_source_image`
when verified record adapters are configured. It emits standard image content
and document/page/original-hash citation metadata, with a separately hashed,
bounded JPEG rendition. Source bytes are verified before isolated rendering;
source/day permission and the pinned connection are rechecked afterward. Missing,
unpublished, changed or revoked sources return no image. The tool is read-only,
accepts only profile/document IDs and treats pixels as untrusted evidence, with
an explicit warning about downscaling/illegibility and client/provider disclosure.
Generated filesystem/child/MCP tests cover source denial and in-flight source or
session revocation. A real stdio SDK client receives and verifies a generated
image, then receives no image after revocation. The SDK fixture uses invented
authorization, not a live database or human-approved grant. Actual Codex client,
browser/database and deployed acceptance remain unverified.
Server typecheck/build and 23 focused MCP/authorized-source/real-stdio tests
passed for this composition. The MCP fixture is a protocol client, not proof of
a configured AI application or a production database-backed source policy.

Approved history now carries the stored source media type as an optional wire
field. The private browser opens PNG/JPEG citations as hash-pinned preserved
images instead of asking the text-page reader for absent OCR. It shows the
document/page/original digest and full-size link, preserves text reading for
legacy/other sources, and clears selected images on close, source failure,
profile/cutoff changes and sign-out. Synthetic UI tests verify media-type
selection independently of filenames, image failures and state clearing.
The SQL metadata assertion is updated but remains unrun pending migration
approval; no database schema or migration has changed.
The focused browser/unit suite passed 14 tests. A Chrome Playwright check also
decoded an independently generated PNG through mocked API responses, verified
the pinned digest and full-size link, and captured desktop/390px screenshots
with no horizontal overflow. Server typecheck passed. This is browser evidence,
not a database-backed deployment or actual AI-client acceptance check.

Release `008d50fd8057b1b73587edb85dac38f0aae2eb26` built successfully on Hermes
as `adeno-private:008d50f`, manifest
`sha256:d0e759044ba7c426842182c93f30771e62717dd687fbf22a1b2711ebbe187e4d`.
Both server and browser production builds passed in the image build. Its
healthcheck is `NONE`. A 60-second-bounded packaging probe ran as `adeno` with
network disabled, read-only root, no mounts, dropped capabilities and a 256 MiB
memory limit. It confirmed native SQLite version retrieval in memory (no schema
or migration), an independently invented Argon2 hash/verify roundtrip, loading
the authorized MCP server, and disabled record/agent defaults. The retained
container `adeno-runtime-probe-008d50f-2` is
`d7a1289cfcee3c70659486821d16aecc77443cdc3586f39065809262d24aea71`;
inspection confirmed exited 0 without OOM and no running containers afterward.
The first retained probe exited 1 because its probe script imported `argon2`
instead of the application's actual `@node-rs/argon2` dependency; correcting the
probe required no product change. No app data was mounted, no listener was
started and no production database was created. This validates current release
packaging, not the remaining composed workflow or deployment acceptance.
