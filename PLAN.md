# End-to-End Build Plan

## Product direction — 2026-09-07

The product is named Adeno. Hosted use is the primary release target; open-source self-hosting is optional. The first-run container experience below describes the existing community foundation, not the intended caregiver onboarding. Prioritize hosted account creation, family access, encrypted record and note intake, Today, timeline, tasks, research chat and managed AI billing with transparent operating-cost recovery. Do not require ordinary caregivers to configure infrastructure or provider API keys.

## Current progress

- Complete: isolated repository, product/security architecture, caregiver design system, Docker runtime, bootstrap token, cryptographic auth primitives, security headers, read-only container, and content-addressed storage.
- Complete: database-independent hostile-upload admission, object integrity manifests, strict OpenAI request/response contracts, evidence/workflow domain rules, synthetic backend/frontend tests, and responsive Chromium/axe checks.
- Complete: database-independent appointment brief generation and a streaming, passphrase-encrypted portable backup format with authenticated manifests, content hashes, and fresh-directory restore checks.
- Complete: forward-only SQLite migrations, persistent owner setup/recovery/session controls, authenticated record intake, pre-parse upload limits, durable jobs, tamper-evident audit verification, caregiver-funded AI gateway configuration, cited draft persistence, authenticated originals, and immutable accept/reject review.
- Complete: case home, accepted-fact timeline, local evidence search, questions, decisions, follow-ups, appointment-brief download/print, owner-encrypted export, and fresh-directory restore verification.
- In progress: corrected-claim editing, local PDF text/OCR rendering, de-identified outside research, caregiver invitations, live restore switching, deletion/retention controls, full integration hardening, and release packaging.

## Definition of done

A caregiver can open the hosted website, create an account, protect the family workspace, invite other adults, and use records, notes, timeline, tasks, explanations and research without infrastructure setup or provider credentials. The operator manages inference and bills transparently to recover costs. E2EE and credential isolation must satisfy the launch gates in `docs/research-hosting-plan.md`. A fresh clone must also remain runnable as the optional community Docker edition. Both paths preserve source citations, human review, persistent data and verified exports.

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

Database migrations are forward-only, checksum-verified, additive, and require explicit maintainer permission before creation or application.

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
