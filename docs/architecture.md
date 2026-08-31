# Architecture

## Decision

Use Python 3.12, FastAPI, Pydantic, the standard SQLite driver with FTS5, React, TypeScript, and Vite.

The React build is served by FastAPI in production. One Uvicorn process, two durable SQLite-backed worker loops (local preprocessing and explicitly requested extraction), and one `/data` volume produce a single portable container.

Python is the primary runtime because PDF/image preprocessing, schema validation, and safe derived-artifact generation are core product functions. The storage and AI boundaries remain interfaces so a later Node, Postgres, or object-storage adapter does not alter domain logic.

## Repository shape

```text
careledger/
  web/                 React interface
  app/api/             HTTP routes and request validation
  app/domain/          Claims, cases, timeline, questions, decisions
  app/storage/         SQLite, content-addressed objects, backup
  app/ingest/          Validation, hashing, PDF/image preprocessing
  app/ai/              OpenAI client, prompts, schemas, validators
  app/search/          SQLite FTS5 retrieval and context assembly
  app/jobs/            Durable queue, leases, retries, idempotency
  app/security/        Setup, sessions, CSRF, rate limits, audit
  tests/fixtures/      Synthetic documents only
  docs/
```

## Persistent data

```text
/data/
  app.sqlite
  objects/sha256/<prefix>/<digest>
  derived/<document-id>/
  backups/
  secrets/
```

Originals are content-addressed, immutable through the application, and stored outside the web root. A logical record references an object plus provenance metadata.

Uploads stream to a same-volume temporary file, validate and hash while streaming, `fsync`, then atomically move into the object store. Duplicate bytes reuse the object but create separate record provenance.

## Domain concepts

- Household, user, session, invitation, recovery code.
- Care profile.
- Source object, document, page, derived artifact.
- Extraction run and durable job.
- Evidence claim, citation, revision, contradiction, review state.
- Timeline event, question, answer, decision, follow-up, appointment note.
- Versioned case brief.
- Research note, source URL, access date, and applicability boundary.
- Audit event, export, backup, restore.

## AI boundary

Use the OpenAI Responses API from the server only.

- `store: false`
- `background: false`
- strict Structured Outputs / JSON Schema
- direct inline file/page inputs rather than persistent hosted file stores
- minimal page batches
- stable hashed `safety_identifier`
- no PHI in logs, URLs, analytics, or browser bundles
- no live web search in the patient-record extraction path

Official OpenAI documentation supports text, image, and file inputs plus structured JSON outputs. `store: false` reduces stored response state but does not by itself provide Zero Data Retention or a BAA. Image/file inputs have provider-specific controls and exceptions. Operators must review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

## Extraction flow

1. Locally render and identify pages.
2. Label documents as untrusted evidence, never instructions.
3. Send the smallest necessary page batch.
4. Require schema-valid claims with source/page citations.
5. Validate citations and source digests locally.
6. Save results as proposed, never accepted.
7. Require caregiver approval or correction.

## Failure model

- Missing/invalid API key: local records remain usable; AI actions show a disabled state.
- Model timeout/rate limit/schema error: bounded retries; partial output is not published.
- Process crash: job leases expire and idempotency prevents duplicate claims.
- Malformed/encrypted/oversized input: quarantine with a specific user-readable reason.
- Disk full: preflight prevents false-success records.
- Database contention: one process, serialized writes, foreign keys, busy timeout, and supported SQLite journaling.
- SQLite schema trust: the Debian runtime's SQLite 3.40 does not mark JSON1 functions innocuous, so `trusted_schema` remains enabled for `CHECK(json_valid(...))`. DDL is accepted only from bundled, ordered, SHA-256-verified migrations; public APIs expose no SQL or schema mutation surface.
- Restore failure: stop before serving data and report the failing digest/integrity check.

## Deployment boundary

- Exactly one application replica for the embedded-database edition.
- A reverse proxy or managed platform terminates TLS for public deployments.
- Vercel/serverless is not supported without external database and object storage.
- Canonical targets: Docker Compose/VPS and Railway with a persistent `/data` volume.
