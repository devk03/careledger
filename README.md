# CareLedger

CareLedger is a self-hosted evidence workspace for adults coordinating a parent or loved one's health care.

Upload medical records, verify extracted facts against the original page, understand unfamiliar language, prepare questions for clinicians, and track what happens next.

## Product promise

- Originals remain immutable and locally stored.
- Every important fact points to a document and page.
- AI output starts as a draft and never silently becomes a medical fact.
- Patient evidence, clinician interpretation, family observations, and general research remain visibly separate.
- The interface explains what is known, what it may mean, what remains unknown, and the next action.

## Run the current foundation

```bash
cp .env.example .env
# Optional: add the caregiver's OPENROUTER_API_KEY to .env
docker compose up --build
```

Open `http://localhost:8080`. On first boot, find the private setup URL with:

```bash
docker compose logs careledger
```

On first boot, the container will print a one-time setup URL. The owner creates a local account; generated application secrets and all health data persist in one mounted `/data` volume.

No hosted database, object store, analytics account, email provider, or authentication service is required. Record storage, fingerprints, source viewing, and human organization work with AI disabled. When a caregiver adds their own OpenRouter or OpenAI key, CareLedger asks for explicit confirmation before sending each original outside the deployment.

## Important limits

CareLedger organizes evidence and drafts questions. It does not diagnose, prescribe, stage cancer, or replace clinicians.

This project is not HIPAA-compliant out of the box and does not provide a Business Associate Agreement. Compliance depends on the operator's deployment, contracts, policies, and use. Supplying an API key does not create a BAA or Zero Data Retention configuration.

## Status

The isolated repository, caregiver interface, persistent owner authentication, forward-only SQLite schema, secure PDF/image intake, immutable SHA-256 object store, durable preprocess/extraction jobs, caregiver-funded AI gateway boundary, strict extraction validation, immutable human review, authenticated source viewing, local accepted-evidence search, care dashboard, questions/follow-ups/decisions, appointment-brief download/print, owner-encrypted backup and tested fresh restore, lockfiles, CI, and hardened single-container runtime are implemented.

The responsive Chromium/axe suite covers 320, 375, 414, and 768 CSS pixels with no serious or critical violations. The container is verified healthy with a read-only root filesystem and a memory-backed `/tmp`.

Dedicated corrected-claim editing, local PDF text/OCR rendering, de-identified outside research, invitations, live restore switching, deletion/retention controls, and release publication remain active build work. Ollama is not yet presented as equivalent to the hosted Responses path because its supported request fields differ; local-model support will use an explicit adapter and compatibility tests.

See [PLAN.md](PLAN.md), [docs/product.md](docs/product.md), [docs/architecture.md](docs/architecture.md), [docs/ingestion-security.md](docs/ingestion-security.md), [docs/openai-boundary.md](docs/openai-boundary.md), [docs/backup-restore.md](docs/backup-restore.md), [docs/deployment.md](docs/deployment.md), [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), and [SECURITY.md](SECURITY.md).
