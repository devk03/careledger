# End-to-End Build Plan

## Current progress

- Complete: isolated repository, product/security architecture, caregiver design system, Docker runtime, bootstrap token, cryptographic auth primitives, security headers, read-only container, and content-addressed storage.
- Complete: database-independent hostile-upload admission, object integrity manifests, strict OpenAI request/response contracts, evidence/workflow domain rules, synthetic backend/frontend tests, and responsive Chromium/axe checks.
- Complete: database-independent appointment brief generation and a streaming, passphrase-encrypted portable backup format with authenticated manifests, content hashes, and fresh-directory restore checks.
- Permission gate: initial SQLite schema/migration and persistent owner setup.
- After migration: authenticated upload/review APIs, durable jobs, case/timeline/question/decision/follow-up workflows, wiring backup/restore and appointment briefs to persistent records, full integration tests, and release packaging.

## Definition of done

A fresh clone can be deployed as one container using only `OPENAI_API_KEY`, followed by first-run local account setup. A caregiver can upload a synthetic PDF or image, verify AI-proposed facts beside the cited source page, view a case summary and timeline, receive plain-language explanations and prioritized next steps, prepare an appointment brief, restart without data loss, and export a verified backup.

Release requires:

- No real patient data in Git history, fixtures, screenshots, logs, or tests.
- Every displayed patient claim has a resolvable local document/page citation or an explicit `user-attested` label.
- AI drafts cannot modify accepted facts without human approval.
- Lint, type checks, unit, integration, security, accessibility, and Playwright tests pass.
- Docker smoke, persistence, backup, restore, and hash-verification tests pass.
- The UI works at 320, 375, 414, and 768 CSS pixels with no serious/critical axe violations.

## Phase 1 - Repository and product foundation

Deliverables:

- Isolated repository with Apache-2.0 license, contribution guide, code of conduct, security policy, and privacy documentation.
- Locked runtime and dependency versions.
- Product vocabulary, evidence categories, risk boundaries, and synthetic fixtures.
- Hallmark design tokens and accessible component foundations.

Exit gate: the repository contains no real case identifiers or records and secret scanning passes.

## Phase 2 - Secure local foundation

Deliverables:

- Single-container FastAPI application serving a compiled React interface.
- One-time setup token, local owner account, Argon2id password hashing, recovery codes, secure sessions, CSRF protection, and login throttling.
- SQLite/FTS5 repository, durable job queue, append-only audit events, and content-addressed `/data` object storage.
- Health endpoints that disclose no record counts, paths, or case data.

Exit gate: setup cannot be reclaimed after first use, unauthorized record access fails, and restart preserves the account.

Database migrations require explicit user permission before creation or application.

## Phase 3 - Record ingestion and provenance

Deliverables:

- PDF, JPEG, and PNG uploads only.
- Magic-byte/MIME validation, size/page/pixel limits, quarantine state, malware hook, streaming SHA-256, atomic same-volume storage, and immutable originals.
- Local PDF text extraction and page rendering in a network-disabled constrained worker.
- Duplicate bytes share one object while retaining separate logical record provenance.

Exit gate: malformed, encrypted, oversized, spoofed, path-traversal, active-content, and decompression-bomb fixtures fail safely.

## Phase 4 - AI extraction and human review

Deliverables:

- Server-only OpenAI Responses API integration using `store: false`, `background: false`, inline file/image inputs, and strict JSON Schema.
- Document text is evidence, never instructions; the model has no mutation, shell, messaging, deletion, or browsing tools.
- Proposed claims include evidence category, uncertainty, document/page citation, quote or bounding box, model, schema version, prompt hash, and source digest.
- Side-by-side page and proposal review with approve, reject, and correct actions. Corrections create revisions.

Exit gate: citationless or schema-invalid output fails closed; prompt-injection fixtures cannot change instructions or trigger tools.

## Phase 5 - Caregiver workflow

Deliverables:

- Home view: `What we know`, `What this means`, `What remains unknown`, `What to do next`.
- Timeline, medication list, questions, decisions, follow-ups, owners, due dates, and appointment notes.
- Plain-language term explanations with a toggle to the exact source wording.
- Appointment brief export with prioritized questions and unresolved commitments.
- Local FTS5 evidence search and cited answers.
- General research is a separate mode: it shows and requires approval of a de-identified query before any web request, and never promotes research into patient fact automatically.

Exit gate: summaries contain no uncited factual claims and every next step is labeled as clinician instruction, caregiver task, or AI draft.

## Phase 6 - Operations, security, and recovery

Deliverables:

- Consistent SQLite online backups plus object/hash manifests.
- Passphrase-encrypted portable export and tested fresh-volume restore.
- Re-authenticated deletion workflow with explicit scope and retention disclosure.
- CSP, safe Markdown, same-origin CORS, rate limits, non-root container, read-only root filesystem, restricted egress, SBOM, secret scanning, SAST, dependency/container scanning, and signed release artifacts.

Exit gate: integrity check passes after abrupt termination and after restore; secrets/PHI do not appear in logs, client bundles, container layers, or CI artifacts.

## Phase 7 - Release and deployment

Deliverables:

- Multi-stage Docker image and canonical Docker Compose configuration.
- `/data` volume, liveness/readiness checks, graceful shutdown, and backup runbook.
- Railway one-service template with persistent volume; VPS/Compose guide as the portable baseline.
- GHCR publishing workflow and release checklist.

Exit gate: `docker compose up --build` reaches readiness in under 90 seconds on a clean machine, first-run setup succeeds, an upload survives rebuild/restart, and backup/restore reproduces every source digest.

Actual publishing or deployment requires explicit authorization and credentials.

## MVP boundary

MVP includes one household per deployment, owner plus invited caregivers, local evidence storage/search, cited AI drafts, human approval, case/timeline/questions/follow-ups, appointment brief, and backup/restore.

Later versions may add passkeys, multilingual explanations, OCR language packs, multi-household administration, external EHR formats, regulated-deployment guidance, and storage/Postgres adapters.
