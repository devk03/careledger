# Run Adeno on your own computer

This optional guide is for the open-source local edition. The hosted service is Adeno's primary product direction. Running your own copy does not provide access to the project's private deployment or credentials.

## Before you start

- Install and start Docker Desktop on Mac or Windows. Linux users can use Docker Engine with the Compose plugin.
- Check `docker compose version` and `docker info` in your terminal. If Docker is not running, open it and wait until it is ready.
- Download this repository using Git or GitHub's Code → Download ZIP. Open a terminal in the folder containing `compose.yaml`. Git clones can use `git clone https://github.com/devk03/careledger.git adeno`, then `cd adeno`.
- No local Python, Node.js, database installation, Railway account, or deployment credential is needed.

## First setup

Copy `.env.example` to `.env` using `cp .env.example .env` on Mac/Linux, or `Copy-Item .env.example .env` in Windows PowerShell. Do this once; overwriting it later loses your saved configuration. Make sure your editor saves `.env`, not `.env.txt`.

You can run without AI immediately:

```bash
docker compose up --build -d
docker compose exec careledger python -m app.setup_link
```

Open the full private link from the second command, including its fragment after `#`. Complete account setup and save the recovery codes somewhere separate. This setup link expires in one hour and is never printed in normal application logs. Rerun the command if it expires. Once setup is complete, open `http://localhost:8080` and sign in.

Internal service and volume names still use `careledger` for compatibility. Use the commands exactly as shown even though the app's name is Adeno.

## Use your own AI key

Edit `.env` locally. Choose one configuration; the examples use placeholders, not usable credentials.

### OpenRouter

```dotenv
AI_PROVIDER=openrouter
AI_MODEL=openai/gpt-5.4-mini
OPENROUTER_API_KEY=your-key-here
OPENAI_API_KEY=
```

The sample model is the current configured integration default, not a claim that it is the cheapest or clinically validated. OpenRouter uses provider-prefixed model IDs. Availability, pricing and privacy-compatible endpoints can change. A replacement must support the Responses API path, appropriate file/image input and the structured-output contract. A free chat model is not automatically interchangeable.

### OpenAI directly

```dotenv
AI_PROVIDER=openai
AI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=your-key-here
OPENROUTER_API_KEY=
```

The direct provider uses an unprefixed model ID. API usage is charged to your provider account, independently of a consumer chat subscription.

### Apply changes

Save `.env`, then run:

```bash
docker compose up -d
```

Compose recreates the service when configuration changes and retains its named data volume. A plain `docker compose restart` does not apply changed environment variables. Refresh the app after startup. Uploaded records can then be submitted for explanation using the app's confirmation flow.

To disable AI, set `AI_PROVIDER=disabled` and run `docker compose up -d` again. Record organization continues to work. Do not use `APP_EDITION=managed` for local setup: that unfinished edition intentionally refuses startup.

### Advanced compatible gateway

Set `AI_PROVIDER=custom_responses`, `AI_MODEL`, `CUSTOM_AI_BASE_URL`, and `CUSTOM_AI_API_KEY`. The gateway must implement the Responses API with the request fields Adeno uses, not merely Chat Completions. OpenRouter must use its dedicated provider mode so its privacy rules remain enforced. Docker's `localhost` points inside the container; it does not automatically reach a model server on your host. This preview does not offer a verified plug-and-play Ollama setup.

## Records, keys and backups

Records, account data and generated application secrets live in Docker's named `/data` volume. They are not stored in the Git checkout. Your provider key is in `.env` and the container's runtime environment; keep local administrator access trusted. `.env` and local health data are excluded from Git and the Docker build context. Never upload them in bug reports.

The community server can read local records. Optional AI sends approved material to the provider; this is not complete E2EE storage or offline inference. OpenRouter requests enforce the existing privacy policy; if no compatible endpoint is available, explanations fail rather than silently weakening it. Do not enable web search on patient-record extraction models.

Use the app's Backup view to download an encrypted backup and keep its passphrase separately. The [backup and restore guide](backup-restore.md) describes verified restore procedures. Stopping/rebuilding retains the volume, but deleting volumes, uninstalling Docker data or resetting Docker Desktop can erase it. Changing the project directory/Compose project name can select a new volume; keep a stable folder and export a backup before moving it.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Docker command missing or cannot connect | Install/open Docker and wait for the engine to start. Check `docker info`. |
| Port 8080 already in use | Set `CARELEDGER_PORT=8081` and `PUBLIC_BASE_URL=http://localhost:8081` together in `.env`, then run `docker compose up -d`. |
| Setup URL expired or `/setup` does not work | Run `docker compose exec careledger python -m app.setup_link` and open its full URL. |
| No AI available | Check the selected provider and corresponding key in `.env`, then recreate with `docker compose up -d`. |
| Provider rejects a request | Check provider balance, model access, supported request fields and privacy-compatible endpoint availability. Free-model quotas and unsupported file/structured-output fields can cause rejection. |
| Changes to `.env` do not appear | Use `docker compose up -d`; restarting alone does not reload container environment variables. |
| App is not ready | Run `docker compose ps` and `docker compose logs --tail=50 careledger`. Review output privately before sharing it. |

To update a Git clone, first export a backup and review release/migration notes, then run `git pull --ff-only` and `docker compose up --build -d`. Preserve `.env` and the Docker volume. Database migrations bundled in an upgrade run at startup, so review them before upgrading.
