# Hermes private MVP

Target origin: `https://adeno.kunjadia.dev`. This is a trusted, server-readable
private deployment, with public signup and invitations disabled. It makes no
managed E2EE claim. Do not import real case records into the repository.

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
No real database or record was read. The paired SQLite/object bundle, off-host
generation retention and full application restore are still unimplemented.

Sharp is now pinned at 0.35.5 in both server and parser lockfiles, addressing
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
Focused image/parser tests pass and both production dependency audits report
zero vulnerabilities. The patched parser still needs a fresh Hermes image smoke
before production intake is enabled.

HTTPS, connector setup, encrypted off-host backups, restore and deployed
acceptance remain unproven. DNS configuration is deferred to the maintainer for
October 15. This document is a runbook candidate, not a readiness claim.
