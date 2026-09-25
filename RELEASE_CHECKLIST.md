# Release Checklist

Do not publish, deploy, push, create a pull request, or tag a release without explicit maintainer authorization.

## Hosted family-record release gate (not yet satisfied)

This is the binding gate for the public, family-controlled E2EE product. The older checklist below describes the community edition and does **not** make the current Python/Railway preview safe for hosted medical records. Use wholly fictional fixtures until every item below passes; no real family record belongs in the repository, a test service, or a support log.

### Product acceptance

- [ ] A fresh household can sign up; its admin can invite two adults and one child into separate accounts. Single-use/expired invitations fail, no member starts with an implicit day grant, and revocation ends browser and agent access on the next request.
- [ ] In a browser, an authorized adult can add one PDF, one JPEG/PNG, and a rough note; attach at least two sources to one care day, another to a different day, and leave one item undated. The UI preserves original upload time separately from document date and care day, and never invents an empty day node.
- [ ] A child contribution stays proposed until a granted adult approves it. Approval creates one new immutable day revision; a stale concurrent edit fails, and permitted members can inspect the prior revision and its author. Web and MCP history through a selected day include only currently approved, permitted sources on or before that care day.
- [ ] The interface makes no diagnosis, treatment recommendation, or monitoring promise. An agent answer is not published as a family fact without human review and provenance: document/page for a report claim, or immutable note ID and user-attested label for a family note.

### Family-controlled privacy and access

- [ ] Browser encryption occurs before hosted transfer. Automated network capture, application/proxy/error logs, database/object files, backups, and analytics contain no marker from fictional record bytes, filenames, patient-like names, timeline text, or search terms; the hosted process never obtains an unwrapped family key.
- [ ] The setup/privacy UI accurately discloses remaining hosted metadata exposure, including exact file length, chunk count, timing, and access patterns; it does not claim that E2EE hides those facts.
- [ ] Ciphertext, IV, tag, chunk order, household, object, revision, and manifest-tampering tests all fail closed with no partial plaintext. A restored older but internally valid manifest is rejected by the documented key-continuity/rollback mechanism.
- [ ] A recovery kit restores a fictional vault on a fresh device. Add-device, remove-device, key-rotation, encrypted export, backup restore, and loss-of-all-keys flows pass browser/end-to-end tests without giving the host a recovery key.
- [ ] Two fictional households pass a denial matrix across list, direct ID, count, cursor, source link, export, search, past day revisions/snapshots, and MCP paths. Current grants and revocation also protect old revisions and sources later hidden or removed; an adult with a narrower day grant cannot infer a hidden day or source. An independent security review signs off on the actual sharing/key model before real records.
- [ ] PDF/photo intake is validated in an isolated client-side or explicitly family-authorized processing path compatible with E2EE. Malformed, active, encrypted, oversized, and resource-exhausting files fail safely; original PDFs are not served inline merely because syntax validation passed. The server-side parser prototype is not counted as this gate.
- [ ] Every transfer of decrypted content to an AI client/provider requires a per-client, person-visible disclosure and consent. A hosted MCP connection exposes only non-medical profile metadata until a separately verified device-held plaintext path is enabled.

### Agent and deployment acceptance

- [ ] A nontechnical adult connects one genuinely supported MCP client from a single short instruction plus one browser approval, without copying an API key, password, or recovery code; an observed fictional-data run takes at most two minutes. The client confirms the account and scopes with a content-free profile tool, and disconnect/revocation blocks its next call.
- [ ] From an agent, the family admin can start the invitation, day-access-grant, and connector setup flows without a terminal or manual token copy. The agent may prepare or explain changes, but each invitation, grant, device enrollment, and key/recovery action requires an exact browser approval by the authorized person; the agent cannot approve itself or read recovery material.
- [ ] At least two adults in one fictional household and one adult in another pass browser/API/MCP end-to-end tests: correct grants, wrong-family denial, current-source citations, backward day cutoff, bounded output, untrusted document text, and no agent self-grant or publish tool.
- [ ] The public HTTPS site links to the exact public, PHI-free source repository; its displayed release SHA matches the deployed SHA. A fresh clone with documented settings starts the self-hosted edition without source edits, and an independent tester completes setup in at most 20 minutes with no mandatory inference key.
- [ ] Locked frontend/server typecheck, test, lint, build, security scans, and browser accessibility checks pass. The hosted end-to-end suite and a two-household ciphertext canary pass on the release candidate; manual GitHub Actions remain manual unless the maintainer explicitly changes that policy.
- [ ] The production image reaches readiness within 90 seconds, stays healthy after one restart/rebuild with its durable volume, and restores an encrypted backup into a fresh instance with object hashes and schema integrity verified. Alerting, exhausted-retry handling, rollback, retention/deletion, and exact release secrets are documented and exercised.
- [ ] The maintainer approves each migration before creation or application, any PR merge, and the exact release commit/destination before public real-record intake. Until then the deployed preview stays labeled fictional-only and managed E2EE startup remains blocked.

## Existing community-edition checklist

## Evidence and privacy

- [ ] Repository history, fixtures, screenshots, logs, and image layers contain synthetic data only.
- [ ] Every patient-specific claim requires a resolvable document/page citation or an explicit user-attested label.
- [ ] AI output remains proposed until human review; rejected or corrected proposals keep an audit trail.
- [ ] Document contents cannot act as instructions or enable tools.
- [ ] No third-party analytics, telemetry, fonts, or browser-side OpenAI requests are present by default.
- [ ] Privacy and retention limitations are visible during setup and export.

## Product behavior

- [ ] A caregiver can upload PDF, JPEG, and PNG records and see clear validation errors.
- [ ] The review view shows the original page beside exact wording and a plain-language draft.
- [ ] Home distinguishes what is known, what it may mean, what remains unknown, and what to do next.
- [ ] Questions and next steps show source, owner, priority, due date, and whether they came from a clinician, caregiver, or AI draft.
- [ ] Appointment brief output is source-linked, prioritized, and usable without the full application.
- [ ] Medical emergency guidance is visible and does not imply monitoring by Adeno.

## Security and recovery

- [ ] Setup is single-use and cannot be reclaimed after owner creation.
- [ ] Authorization covers every record, page, citation, export, preview, and search response.
- [ ] Login, setup, upload, AI, export, and deletion routes have appropriate CSRF, re-authentication, rate, and concurrency controls.
- [ ] Malformed, spoofed, active, encrypted, oversized, traversal, and decompression-bomb uploads fail safely.
- [ ] OpenAI calls set `store: false`, disable background mode and tools, use strict structured output, and validate citations locally.
- [ ] Container runs non-root with read-only root, memory-backed `/tmp`, dropped capabilities, and no-new-privileges.
- [ ] Portable backup, off-host copy, fresh restore, SQLite integrity, foreign keys, and every object hash are verified.
- [ ] Re-authenticated deletion declares exact scope and has a tested retention outcome.

## Verification

- [ ] Backend tests, Ruff, and mypy pass from locked dependencies.
- [ ] Frontend unit tests, build, and lint pass from the lockfile.
- [ ] Playwright and axe pass at 320, 375, 414, and 768 CSS pixels with no serious or critical violations.
- [ ] Container builds, reaches readiness within 90 seconds, handles termination, and preserves data across restart/rebuild.
- [ ] Secret, identifier, dependency, SAST, and container scans pass.
- [ ] SBOM and signed release artifacts are generated and verified.
- [ ] Fresh-clone instructions have been followed by someone other than the implementer.

## Publication gate

- [ ] Maintainer explicitly approved the exact commit, destination, visibility, and release version.
- [ ] Security reporting channel and supported-version policy are live.
- [ ] Deployment templates contain no credentials and require durable storage.
- [ ] Release notes state the medical, privacy, hosting, and regulatory limitations plainly.
