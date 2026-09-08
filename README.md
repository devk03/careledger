# Adeno

Adeno is an open-source health workspace designed primarily as a hosted service for adults coordinating a parent or loved one's care.

The intended core experience is: add records and notes after a visit or treatment, review a source-linked family update, and let each adult family member sign in to see the same approved update and their own responsibilities. Caregivers should not need to deploy software, obtain API keys, or choose models. Self-hosting remains an optional path from the same open-source codebase. The long-term funding goal is community-supported access with strictly metered operating costs, not profit.

The hosted service is under development. Today's runnable build is a local community preview; public signup, individual family access, versioned family updates, managed billing, research mode and complete E2EE integration are not yet available. The [core platform plan](docs/core-platform.md) controls the next build scope. Outbound email, WhatsApp and push are deferred.

Upload medical records, verify extracted facts against the original page, understand unfamiliar language, prepare questions for clinicians, and track what happens next.

## Product promise

- Originals remain immutable in the installation's storage; current server storage is not end-to-end encrypted.
- Every important fact points to a document and page.
- AI output starts as a draft and never silently becomes a medical fact.
- Patient evidence, clinician interpretation, family observations, and general research remain visibly separate.
- The interface explains what is known, what it may mean, what remains unknown, and the next action.

## Run the local preview (optional)

Install and open [Docker Desktop](https://www.docker.com/products/docker-desktop/) first. It includes Docker Compose; you do not need Python, Node.js, or a separate database.

**1. Download Adeno.** With Git installed:

```bash
git clone https://github.com/devk03/careledger.git adeno
cd adeno
cp .env.example .env
```

Or choose **Code → Download ZIP** on this repository, extract it, and open a terminal in the extracted folder. Copy `.env.example` to `.env`. In Windows PowerShell, use `Copy-Item .env.example .env`. Only make this copy on first setup; keep an existing `.env` when updating.

**2. Optional: turn on AI.** Open `.env` in a text editor. For OpenRouter, replace the empty key line with your own key:

```dotenv
AI_PROVIDER=openrouter
AI_MODEL=openai/gpt-5.4-mini
OPENROUTER_API_KEY=your-key-here
```

For a direct OpenAI account instead:

```dotenv
AI_PROVIDER=openai
AI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=your-key-here
```

Use one provider. Replace `your-key-here` with a real API key from that provider's account dashboard; it is not a working key. Provider API usage is billed to your account. Leave the original `.env` unchanged if you want to organize records without AI. More options and troubleshooting are in the [local setup guide](docs/local-setup.md).

**3. Start the app.** Run these in the downloaded project folder:

```bash
docker compose up --build -d
docker compose exec careledger python -m app.setup_link
```

The first build downloads dependencies and may take several minutes. Open the full setup URL printed by the second command, create your account, and save the recovery codes. After setup, use [localhost:8080](http://localhost:8080).

The `careledger` command/service name is retained internally for compatibility; the application is Adeno. The setup link is private and expires after one hour. Run the second command again to obtain a fresh link if needed.

**Everyday commands**

```bash
docker compose stop       # Stop the app and keep records
docker compose up -d      # Start again, or apply an edited .env
docker compose ps        # Check whether the app is healthy
```

Your records and account live in the persistent Docker volume, so stopping or rebuilding the app keeps them. Export backups from the app and keep them separately. Removing the volume or resetting Docker can erase local records.

Keys stay on your local server and are excluded from Git and Docker build context. Never paste `.env`, setup links, or recovery codes into issues. The local edition is not end-to-end encrypted storage: your computer's server can read its records, and approved AI requests send selected content to the provider. Only your computer can connect to the default local port.

No hosted database, object store, analytics account, email provider, or authentication service is required. Record storage, fingerprints, source viewing, and human organization work with AI disabled. When a caregiver adds their own OpenRouter or OpenAI key, Adeno asks for explicit confirmation before sending each original outside the deployment.

## Important limits

Adeno organizes evidence and drafts questions. It does not diagnose, prescribe, stage cancer, or replace clinicians.

This project is not HIPAA-compliant out of the box and does not provide a Business Associate Agreement. Compliance depends on the operator's deployment, contracts, policies, and use. Supplying an API key does not create a BAA or Zero Data Retention configuration.

## Status

The interface now includes a shared warm-paper component library, responsive welcome and working pages, a clickable GitHub link with a cached public star count, fictional caregiver examples, and About/privacy pages that distinguish current capabilities from plans. See the [UI library guide](docs/ui-library.md) for the isolated, fictional-data UI preview. That preview cannot save changes or call AI and is separate from the functional Docker app.

The isolated repository, caregiver interface, persistent owner authentication, forward-only SQLite schema, secure PDF/image intake, immutable SHA-256 object store, durable preprocess/extraction jobs, caregiver-funded AI gateway boundary, strict extraction validation, immutable human review, authenticated source viewing, local accepted-evidence search, care dashboard, questions/follow-ups/decisions, appointment-brief download/print, owner-encrypted backup and tested fresh restore, lockfiles, CI, and hardened single-container runtime are implemented.

The responsive Chromium/axe suite covers 320, 375, 414, 768 and 1280 CSS pixels. GitHub Actions runs only when a maintainer starts it manually; pushing changes does not trigger CI. The Docker runtime is configured with a read-only root filesystem and a memory-backed `/tmp`.

Dedicated corrected-claim editing, local PDF text/OCR rendering, de-identified outside research, invitations, live restore switching, deletion/retention controls, and release publication remain active build work. Ollama is not yet presented as equivalent to the hosted Responses path because its supported request fields differ; local-model support will use an explicit adapter and compatibility tests.

See [PLAN.md](PLAN.md), [docs/product.md](docs/product.md), [docs/architecture.md](docs/architecture.md), [docs/ingestion-security.md](docs/ingestion-security.md), [docs/openai-boundary.md](docs/openai-boundary.md), [docs/backup-restore.md](docs/backup-restore.md), [docs/deployment.md](docs/deployment.md), [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), and [SECURITY.md](SECURITY.md).
