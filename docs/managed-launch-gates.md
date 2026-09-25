# Managed launch gates

Status: **not ready for real family records**. This is the current evidence
checklist for the public, open-source, Railway-hosted Adeno target. It does not
replace the separate [trusted local pilot](all-typescript-family-pilot.md),
which permits a server-readable database. The hosted target keeps record keys
on family devices and health content ciphertext-only on the server.

`PASS` below requires the stated evidence, not a plausible design or one unit
test. A partial primitive does not turn its parent gate green. All acceptance
fixtures must be wholly fictional and independently invented, never derived by
editing a real person's records.

| Gate | Binary acceptance evidence | Current state |
| --- | --- | --- |
| Public source and privacy | GitHub repo is publicly reachable, site links to it, the complete pushed history passes `node tools/privacyAudit.mjs` with zero findings, and no real record or secret appears in build/deploy artifacts. | GitHub link exists in `web/src/GitHubLink.tsx`; the tracked history/index audit passed at the last checked commit. Re-audit the staged release, public reachability and deployment artifacts before promotion. |
| Reproducible builds | Fresh clone builds and starts the documented community edition with no project-owned API key; server/web TypeScript, unit, browser, accessibility and security suites pass on the release commit. | README documents community Docker setup. Managed edition is deliberately unavailable; a fresh-clone managed run and release-wide green check are missing. |
| Isolated managed schema | Independently versioned schema applies only to a new fictional DB first; checksums, private file modes, foreign keys, trigger behavior, cross-family rejection, concurrent grant/nonce/revision races and rollback are tested. No automatic conversion of community/real DBs. | `0001`–`0007` registered drafts and a gated fictional-only runner exist. `0008` is an unregistered historical-key-backfill draft. **No managed migration has been applied**; fictional managed DB application awaits separate explicit approval. These drafts have not been SQLite-executed or proven against two fictional families. |
| Individual family identity | Two fictional households can sign up independently; each adult has their own login/device, one-use recipient-bound invitations, session/CSRF/Origin checks, recovery and revocation. A disabled account/device is denied on the next request. | Local trusted TypeScript pilot has some individual-account behavior. Managed identity and enrollment are schema/prototypes, not mounted runtime. |
| Family-controlled E2EE | Browser encrypts originals, note text, care dates, filenames, derived text and member-appropriate index before upload. Server/DB/logs/backups contain no fictional medical plaintext marker or unwrapped key. Per-day/source/draft keys, verified device enrollment, owner recovery and rotation pass two-family tests and independent security review. Privacy notice states that an operator serving altered web JavaScript could read an unlocked vault; stronger protection needs a separately signed installed client. | Browser crypto and purpose-bound v2 envelopes have focused fictional tests. Ordinary and distinct historical-backfill actions now have browser signers, pure server verifiers and cross-runtime fictional signature vectors; only ordinary issuance has an unmounted transactional writer. `0006`–`0007` remain unapplied and `0008` is unregistered. The writer has compiled but has not run against managed SQLite; historical backfill authorization/UI, read-time authorization, complete key hierarchy, client witness and independent deployed-flow review are missing. The web-delivery threat is documented in `docs/e2ee-managed.md`, not eliminated. |
| Browser release integrity | Strict CSP and XSS defenses, pinned dependencies, reviewed reproducible builds, signed release artifacts and a rapid frontend-compromise response process are verified on the deployed web origin. The privacy notice still discloses that operator-served JavaScript can read an unlocked vault; these controls reduce accidents, not a malicious serving-origin threat. | Existing security guidance requires these controls; managed web release and incident response are not verified. |
| Recovery continuity | Fictional tests cover loss of every authorized device, restoration of the owner root and authorized per-day/source keys, rejection or safely reviewed recovery when removal would leave no admin, compromised recovery material and key rotation. The UI explains that no devices **and** no recovery material means unrecoverable records; a server reset alone never grants owner access. | Household-key recovery prototypes exist. Managed owner-root recovery, multi-device continuity, compromise rotation and last-admin handling are missing. |
| Record intake and daily timeline | Batch PDF/photo/note intake preserves originals and upload times; care/document/report dates remain separate. One populated day can hold several files. Undated, planned, occurred and corrected entries are source-linked and versioned. Late earlier-day material appears in a backward read without a cached AI consensus. | Community UI and trusted pilot cover pieces; an unmounted encrypted draft preparer and client-side timeline projector exist. Additive `0005` drafts separate source/draft storage and signed two-blob pending-pair registration, but it has not been applied or tested; no draft-intent issuer, non-day runtime, persisted/authorized purpose-bound key envelope, adult review path or end-to-end browser flow exists. |
| Safe document processing | Before accepting a PDF/photo, exact bytes, type, size, page/pixel limits, malware verdict and active-content policy are enforced with bounded resources. The target-host parser isolation and crash recovery are tested. Under managed E2EE, plaintext inspection runs on an authorized device or separately approved family-controlled path—not silently on the hosted server. Unsupported formats, warnings, repaired/ambiguous PDFs, scanner failure and timeouts reject. | The [PDF gate](pdf-intake-gate.md) remains closed; the isolated preview rejects every PDF. Synthetic PNG/parser and qpdf transport probes do not establish production safety or a managed client-side scanner. |
| Grants, revisions and review | Per-member day/source rights apply to every web/API/MCP read and write, including historical versions. Child submissions remain private pending adult approval; stale edits fail. Hidden-day counts, cursors and direct IDs leak nothing. | Managed grant/revision SQL drafts exist. Transactional managed authorization, child review, index visibility and two-family tests are missing. |
| Ciphertext upload durability | Intent is bound to session, scope, key, device and server-issued blob ID. Private objects are staged, fsynced and re-read first; one database transaction then rechecks nonce uniqueness, current grant, quota, one-use state and the exact v2 object references. Crash/restart reconciliation handles the unavoidable filesystem/SQLite commit gap. Malformed, revoked and duplicate uploads fail closed. | The unmounted **ciphertext wire-framing** parser, object store, byte proof and staging adapter pass focused fictional tests. A ledger, one-attempt-per-intent pre-write lease, authorized positive commit receipt and client-side digest comparator are drafted, but none have run as a managed end-to-end flow or against a migrated database; `0004` triggers, SQLite receipt isolation/revocation and contention are untested. A new session for the same active writer account may check an older intent; the original device and current grant must still be active. The client must persist its wire digest before upload and compare it with the receipt; persistence is not yet implemented. An absent receipt means only “unconfirmed” (possibly indefinitely), never “safe to retry.” Aborted leases remain charged: cleanup/reconciliation, safe retry, global disk quota, end-to-end uncertain-commit recovery and route activation are missing. That parser is not a safe PDF/document inspector. |
| Backward context and freshness | An authorized client traverses current encrypted index/day revisions backward through a chosen care day. Device-pinned heads reject forks; a fresh/recovered device independently verifies the latest grant and index head. | Client projection and signed-head prototype exist. Persisted encrypted index and independent freshness witness are missing; this is a real-record blocker. |
| Device-held agent connection | A nontechnical adult signs in and gives one supported desktop/CLI agent a short public setup instruction. Human approval selects account/family/scopes; disconnect revokes access. A local companion holds authorized keys, decrypts approved content on that device, returns bounded cited results, and completes one real-client setup in under two minutes. | Local/trusted MCP proof exists, but managed OAuth/consent, local E2EE companion and live client setup are missing. Hosted MCP must not return medical plaintext. |
| Cloud-client disclosure | Each supported web-only AI client has a separately verified, explicitly approved device-to-client sharing path and a plain-language disclosure of what its provider receives and retains. Unsupported clients receive only non-medical connection metadata, not a misleading success state. | No cloud-client private-record path is verified. The local companion cannot simply be reached from a cloud-hosted client; do not promise universal one-click access. |
| AI output and untrusted sources | Optional Adeno-generated classification/explanation stays proposed until human review, resolves each important claim to the exact local document/page, and never diagnoses, prescribes, recommends treatment, creates clinical tasks or publishes a day. Prompt-like text in records is treated as evidence, not agent instructions; Adeno extraction and MCP tools have no authority to bypass approval. An independent AI client remains outside Adeno's behavioral control and requires clear disclosure. | Community extraction/review has safeguards, but the managed browser/MCP path and its adversarial document tests are missing. No model is required for core storage and traversal. |
| Backup and restore | A consistent DB snapshot plus only committed ciphertext objects, envelopes, keys' encrypted recovery material and signed heads are bound to one authenticated backup. At least one access-controlled encrypted copy is off-host, retained in documented generations, and exercised in scheduled fresh-instance restore drills. Restore verifies every digest and the independent latest-head witness before serving reads. | Unmounted object-only snapshot/restore primitives pass fictional tests. Consistent DB capture, off-host encrypted generations, scheduled drills, coordinated fresh restore and startup verification are missing. |
| Record lifecycle | Families can export their own encrypted records and understandable source-linked history; documented retention and re-authenticated deletion/tombstone flows cover ciphertext, old revisions, backups, orphan objects, account metadata and keys. Revocation limits are explained, including material already downloaded. | Complete managed export, deletion/retention and orphan reconciliation are missing. No deletion workflow should be inferred from immutable storage or from the object-only backup primitives. |
| Operations and costs | Per-family/global quotas, abuse controls, auditable reservations, orphan cleanup, secret isolation, redacted logs, incident runbook and bounded operating costs work under concurrent use. No inference charge is incurred without the approved funding path. | Not yet established for public managed mode. No new secret, billing or external witness service should be provisioned without separate authorization. |
| Operator and legal readiness | Before accepting real records, publish the operator identity/contact, accurate privacy and subprocessor notice, applicable processing geography, consent and rights-request path, retention schedule and incident-response process. Obtain qualified review of applicable health-data obligations, contracts and any BAA decision; do not imply HIPAA compliance or tax-deductible nonprofit status without evidence. | `SECURITY.md` states the software has no out-of-box HIPAA compliance or BAA. Hosted operator policy, contractual and incident-response gates remain open. |
| Railway release and rollback | Reviewed release commit is deployed over HTTPS with one writer, durable storage, readiness checks, signed backup, demonstrated redeploy persistence and tested rollback. SBOM, dependency/SAST/secret/container scans and signed release artifacts pass; the deployed image digest matches the reviewed artifact. Public site links to source and clearly distinguishes information organization from medical advice. | An earlier community preview URL is not proof of this managed release. No live managed deployment, signed artifact verification or rollback verification exists. See `RELEASE_CHECKLIST.md` for the broader release process. |

## Mandatory two-family acceptance run

The release test uses two unrelated invented families, at least two adults and
one child. It must show, through a real browser, API and one supported MCP
client: zero cross-family reads or writes; wrong-scope and revoked access denied
on the next request; one day with two files and a note; a separate result day;
an undated item; a late upload about an earlier day; one correction with old
version preserved; and a child proposal that does not alter the published day
until adult approval. Upload timestamp must never become a care date. A supported
agent must also traverse an authorized date range, receive source provenance,
and answer a fictional informational history question using the approved PDF,
photo and note through a device-held decryption path. The hosted server never
receives clinical plaintext or unwrapped keys. A selected external AI
client/provider may receive plaintext directly from the authorized device only
after the person's explicit, informed approval.

The same run must attempt malformed/truncated/v1 ciphertext, duplicate nonces,
stale revisions, concurrent conflicting grants, tampered disk objects, hidden
day enumeration, process interruption during staging/commit, backup alteration,
and fresh restore. Search the database, object store, logs, HTTP errors and
backup for fictional medical-content markers, filenames, care/document dates
and unwrapped keys; the acceptable count on those Adeno-operated surfaces is
**zero**. The default acceptance run uses a local client with no external model
provider disclosure. A separate cloud-client run may transfer only selected
content after the person's explicit opt-in, and must record that provider
exposure honestly.
Operational account/contact fields and upload timestamps are separately
disclosed metadata, not care dates. A passing narrow
unit test is not evidence for this end-to-end claim.

Document-safety cases must include synthetic active-content and malformed PDFs,
large/hostile images, scanner failure, decoder timeout/crash, wrong-patient and
conflicting-date material, plus a record containing fake system instructions
and an exfiltration request. Unsupported PDFs remain rejected until the closed
PDF gate has actually passed. An informational agent answer must cite the exact
local document and page where pages exist. A photo cites its immutable image
source ID (and region/page where available) with the source's provenance; a
family note cites its immutable note ID and is labeled user-attested.
Classification is only a proposal and no model or injected
document text may approve/publish entries or create clinical tasks. Adeno-owned
automated outputs must not diagnose, prescribe or recommend treatment; the
behavior of an independent external AI client cannot be guaranteed by Adeno.

## Immediate critical path and authority boundary

1. Obtain separate approval to apply the seven registered managed drafts **only** to a
   new private fictional local database. Run the pinned runner, inspect the
   schema, then test two-family denial, triggers and concurrency. Do not apply
   them to the community, Hermes, Railway or real-family database.
   Review and register the separate historical-backfill draft only after its
   distinct signed-action verifier and tests exist.
2. Implement and test managed session/device enrollment, the atomic upload
   ledger with quota and orphan reconciliation, and authenticated encrypted
   reads. Keep managed startup disabled until the entire chain is proven.
3. Complete encrypted client intake/index, per-member key grants, review and
   day history; then prove the device-held MCP consent path with one real client.
4. Bind database and object backups, solve fresh-device head freshness, run the
   full fictional acceptance suite and independent security review.
5. Only then seek separate authorization for real-record pilot deployment,
   required secrets/services, release PR merge and public Railway cutover.

No gate here authorizes a migration application, PR merge, payment integration,
external data disclosure or use of real family records.
