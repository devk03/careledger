# Release Checklist

Do not publish, deploy, push, create a pull request, or tag a release without explicit maintainer authorization.

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
