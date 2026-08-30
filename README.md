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
export OPENAI_API_KEY=your_key
docker compose up --build
```

Open `http://localhost:8080`. On first boot, find the private setup URL with:

```bash
docker compose logs careledger
```

On first boot, the container will print a one-time setup URL. The owner creates a local account; generated application secrets and all health data persist in one mounted `/data` volume.

No hosted database, object store, analytics account, email provider, or authentication service is required.

## Important limits

CareLedger organizes evidence and drafts questions. It does not diagnose, prescribe, stage cancer, or replace clinicians.

This project is not HIPAA-compliant out of the box and does not provide a Business Associate Agreement. Compliance depends on the operator's deployment, contracts, policies, and use. Supplying an API key does not create a BAA or Zero Data Retention configuration.

## Status

The isolated repository, caregiver interface, FastAPI runtime, expiring one-time setup secret, Argon2id/session/CSRF primitives, quarantine admission pipeline, immutable SHA-256 object store and integrity manifests, strict OpenAI extraction boundary, caregiver appointment-brief formatter, passphrase-encrypted portable backup format, lockfiles, CI, unit/integration/accessibility tests, and hardened single-container deployment are implemented.

The responsive Chromium/axe suite covers 320, 375, 414, and 768 CSS pixels with no serious or critical violations. The container is verified healthy with a read-only root filesystem and a memory-backed `/tmp`.

The account, record, timeline, review, and job tables and their HTTP workflows are intentionally not present yet. The appointment and backup components are tested library code but are not wired to the interface until those persistent workflows exist. The initial database migration requires explicit maintainer permission before it is created or applied.

See [PLAN.md](PLAN.md), [docs/product.md](docs/product.md), [docs/architecture.md](docs/architecture.md), [docs/ingestion-security.md](docs/ingestion-security.md), [docs/openai-boundary.md](docs/openai-boundary.md), [docs/backup-restore.md](docs/backup-restore.md), [docs/deployment.md](docs/deployment.md), [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), and [SECURITY.md](SECURITY.md).
