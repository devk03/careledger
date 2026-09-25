# Deployment

See [the research, hosting, and API security plan](research-hosting-plan.md) for the proposed hosted service, Cloudflare compatibility, provider comparison, and launch gates reviewed 2026-09-07. The current runnable edition remains the community Docker application.

## Supported baseline: Docker Compose

The portable deployment target is one Adeno container plus one persistent `/data` volume. It needs a first-run owner setup but no AI key. A caregiver-owned OpenRouter or OpenAI key is optional; Adeno does not need a hosted database, object store, auth provider, analytics account, or email service.

Mount `/data` explicitly with Compose or the hosting platform. The image omits Docker's `VOLUME` instruction because Railway rejects it; Compose and Railway persistent-volume mounts still provide durability.

```bash
cp .env.example .env
# Optional: set OPENROUTER_API_KEY in .env
docker compose up --build
```

Open `http://localhost:8080`. Retrieve the one-time setup URL using `docker compose exec careledger python -m app.setup_link`, open it locally, and create the owner account before exposing the service. Do not publish this operator-only command output.

## Restricted Railway preview

The first Railway release is an access-restricted, single-household community preview for fictional testing. Managed E2EE and public family signup remain disabled. Set `APP_ENVIRONMENT=staging`, `APP_EDITION=community`, `AI_PROVIDER=disabled`, `DATA_DIR=/data`, the exact HTTPS `PUBLIC_BASE_URL`, and a random runtime `STAGING_ACCESS_PASSWORD` of at least 32 characters. The browser's outer access prompt uses username `adeno`; the normal application login remains independently required. Only GET health endpoints bypass the outer gate.

The web UI also shows a persistent fictional-records-only notice in staging. It stays visible if the runtime-mode check fails and disappears only when the server explicitly reports a non-preview environment. Do not treat this notice as a substitute for the password gate or as permission to upload real records.

Use one replica, a durable volume at `/data`, health check `/health/ready`, and start command `python -m app.railway_start`. Railway mounts volumes as root; set `RAILWAY_RUN_UID=0` only with this entrypoint. It adjusts the mount-root ownership without recursion, clears supplementary groups, and drops to UID/GID 10001 before launching the server. Verify the running process UID and a restart with the same volume. Never start `app.run` directly as root.

Deploy only an audited `git archive` of the release commit, not the private parent workspace or a general filesystem copy. Docker's build context is allowlisted. Provider keys remain unset for this preview. Retrieve setup privately through the operator shell using `python -m app.setup_link`; never put its token in build/runtime logs or GitHub.

When building a release image, pass the exact 40-character public Git commit as Docker build argument `ADENO_RELEASE_SHA`. The public footer then links to that source commit; absent or malformed values omit the link instead of displaying an unverifiable revision. Compare the live footer link with the archived release commit before admitting users. This is an operator-supplied provenance label, not a cryptographic attestation of the running image.

For an internet-facing deployment:

- Put Adeno behind a trusted TLS reverse proxy and set `PUBLIC_BASE_URL` to its exact `https://` origin.
- Run exactly one application replica for the SQLite MVP.
- Keep `/data` on durable storage with enough space for originals, page renders, database growth, quarantine, and backup staging.
- Preserve the container controls in `compose.yaml`: read-only root, memory-backed `/tmp`, all Linux capabilities dropped, and no-new-privileges.
- Restrict administrative access and outbound network access. When AI is enabled, allow only the configured HTTPS gateway; document any additional exception before enabling it.
- Do not place provider keys in a browser bundle, Git, an image layer, a support archive, or routine logs.
- Back up and test restore before upgrades.

The current image runs as UID/GID `10001`. The mounted `/data` directory must be writable by that identity. A platform that creates root-owned volumes must provide an equivalent safe ownership mechanism; do not solve this by running the long-lived application process as root.

## Health and shutdown

- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`
- Container port: the platform `PORT` value, otherwise `APP_PORT` (default `8080`)

The container uses an init process in Compose and the server handles termination signals. Deployments should stop routing traffic when readiness fails and allow a graceful shutdown window.

## Railway status

Railway can build the repository Dockerfile, import Docker Compose services, and attach persistent volumes. Railway's legacy Config as Code files are deprecated, so Adeno does not ship a new `railway.json` as its primary deployment path.

A public Railway template remains a release task, not a committed secret or a silent deployment action. Before publishing it, verify:

- one service and one replica;
- Dockerfile build and `/health/ready` health check;
- a persistent volume mounted at `/data` with ownership compatible with UID/GID `10001`;
- optional caregiver-owned provider key and generated `PUBLIC_BASE_URL`;
- no health data, setup token, passphrase, or secret in template variables, build output, or logs;
- backup and restore against a fresh volume.

See Railway's official [Dockerfile](https://docs.railway.com/builds/dockerfiles), [Docker Compose](https://docs.railway.com/guides/docker-compose), [volumes](https://docs.railway.com/volumes), [volume backups](https://docs.railway.com/volumes/backups), and [template](https://docs.railway.com/templates/create) documentation for the platform steps current at deployment time.

Publishing or deploying any template requires explicit maintainer authorization and credentials.
