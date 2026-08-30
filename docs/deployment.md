# Deployment

## Supported baseline: Docker Compose

The portable deployment target is one CareLedger container plus one persistent `/data` volume. It needs an OpenAI API key and a first-run owner setup; it does not need a hosted database, object store, auth provider, analytics account, or email service.

```bash
export OPENAI_API_KEY=your_key
docker compose up --build
```

Open `http://localhost:8080`. Retrieve the one-time setup URL from `docker compose logs careledger`, open it locally, and create the owner account before exposing the service.

For an internet-facing deployment:

- Put CareLedger behind a trusted TLS reverse proxy and set `PUBLIC_BASE_URL` to its exact `https://` origin.
- Run exactly one application replica for the SQLite MVP.
- Keep `/data` on durable storage with enough space for originals, page renders, database growth, quarantine, and backup staging.
- Preserve the container controls in `compose.yaml`: read-only root, memory-backed `/tmp`, all Linux capabilities dropped, and no-new-privileges.
- Restrict administrative access and outbound network access. The application needs HTTPS access to the configured OpenAI API endpoint; document any additional exception before enabling it.
- Do not place the OpenAI key in a browser bundle, Git, an image layer, a support archive, or routine logs.
- Back up and test restore before upgrades.

The current image runs as UID/GID `10001`. The mounted `/data` directory must be writable by that identity. A platform that creates root-owned volumes must provide an equivalent safe ownership mechanism; do not solve this by running the long-lived application process as root.

## Health and shutdown

- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`
- Container port: the platform `PORT` value, otherwise `APP_PORT` (default `8080`)

The container uses an init process in Compose and the server handles termination signals. Deployments should stop routing traffic when readiness fails and allow a graceful shutdown window.

## Railway status

Railway can build the repository Dockerfile, import Docker Compose services, and attach persistent volumes. Railway's legacy Config as Code files are deprecated, so CareLedger does not ship a new `railway.json` as its primary deployment path.

A public Railway template remains a release task, not a committed secret or a silent deployment action. Before publishing it, verify:

- one service and one replica;
- Dockerfile build and `/health/ready` health check;
- a persistent volume mounted at `/data` with ownership compatible with UID/GID `10001`;
- required `OPENAI_API_KEY` and generated `PUBLIC_BASE_URL`;
- no health data, setup token, passphrase, or secret in template variables, build output, or logs;
- backup and restore against a fresh volume.

See Railway's official [Dockerfile](https://docs.railway.com/builds/dockerfiles), [Docker Compose](https://docs.railway.com/guides/docker-compose), [volumes](https://docs.railway.com/volumes), [volume backups](https://docs.railway.com/volumes/backups), and [template](https://docs.railway.com/templates/create) documentation for the platform steps current at deployment time.

Publishing or deploying any template requires explicit maintainer authorization and credentials.
