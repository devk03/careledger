# Adeno

Adeno is an open-source health workspace designed primarily as a hosted service for adults coordinating a parent or loved one's care.

The primary experience is to open the website, create an account, invite family, and add records or unorganized thoughts. Adeno will manage hosting and AI access, with transparent charges that cover operating costs. Caregivers should not need to deploy software, obtain API keys, or choose models. Self-hosting remains an optional path from the same open-source codebase.

The hosted service is under development. Today's runnable build is a local community preview; public signup, managed billing, family access, research mode and complete E2EE integration are not yet available. See the [hosted product direction](docs/product.md) and [implementation plan](docs/research-hosting-plan.md).

Upload medical records, verify extracted facts against the original page, understand unfamiliar language, prepare questions for clinicians, and track what happens next.

## Product promise

- Originals remain immutable and locally stored.
- Every important fact points to a document and page.
- AI output starts as a draft and never silently becomes a medical fact.
- Patient evidence, clinician interpretation, family observations, and general research remain visibly separate.
- The interface explains what is known, what it may mean, what remains unknown, and the next action.

## Run the local preview (optional)

```bash
cp .env.example .env
# Optional: add the caregiver's OPENROUTER_API_KEY to .env
docker compose up --build
```

Open `http://localhost:8080`. On first boot, find the private setup URL with:

```bash
docker compose exec careledger python -m app.setup_link
```

The operator command displays a one-time setup URL privately; routine application logs never contain it. The owner creates a local account; generated application secrets and all health data persist in one mounted `/data` volume.

No hosted database, object store, analytics account, email provider, or authentication service is required. Record storage, fingerprints, source viewing, and human organization work with AI disabled. When a caregiver adds their own OpenRouter or OpenAI key, Adeno asks for explicit confirmation before sending each original outside the deployment.

## Important limits

Adeno organizes evidence and drafts questions. It does not diagnose, prescribe, stage cancer, or replace clinicians.

This project is not HIPAA-compliant out of the box and does not provide a Business Associate Agreement. Compliance depends on the operator's deployment, contracts, policies, and use. Supplying an API key does not create a BAA or Zero Data Retention configuration.

## Status

The isolated repository, caregiver interface, persistent owner authentication, forward-only SQLite schema, secure PDF/image intake, immutable SHA-256 object store, durable preprocess/extraction jobs, caregiver-funded AI gateway boundary, strict extraction validation, immutable human review, authenticated source viewing, local accepted-evidence search, care dashboard, questions/follow-ups/decisions, appointment-brief download/print, owner-encrypted backup and tested fresh restore, lockfiles, CI, and hardened single-container runtime are implemented.

The responsive Chromium/axe suite covers 320, 375, 414, and 768 CSS pixels with no serious or critical violations. The container is verified healthy with a read-only root filesystem and a memory-backed `/tmp`.

Dedicated corrected-claim editing, local PDF text/OCR rendering, de-identified outside research, invitations, live restore switching, deletion/retention controls, and release publication remain active build work. Ollama is not yet presented as equivalent to the hosted Responses path because its supported request fields differ; local-model support will use an explicit adapter and compatibility tests.

See [PLAN.md](PLAN.md), [docs/product.md](docs/product.md), [docs/architecture.md](docs/architecture.md), [docs/ingestion-security.md](docs/ingestion-security.md), [docs/openai-boundary.md](docs/openai-boundary.md), [docs/backup-restore.md](docs/backup-restore.md), [docs/deployment.md](docs/deployment.md), [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), and [SECURITY.md](SECURITY.md).
