# Contributing

Thank you for helping caregivers understand health records without losing the source truth.

## Ground rules

- Never use real patient records, identifiers, credentials, or screenshots in issues, tests, commits, or pull requests.
- Use synthetic fixtures only. A fixture must say that it is fictional.
- AI output is proposed evidence until a person reviews it beside the cited source.
- Keep medical language cautious. Adeno organizes information; it does not diagnose or replace clinicians.
- Include tests for behavior changes and accessibility checks for interface changes.
- Before committing or pushing, stage intended files and run `node tools/privacyAudit.mjs`.
  It checks staged paths/bytes and reachable Git history without printing
  suspected content. A clean result is a heuristic, not proof that all private
  information is absent; review the actual diff and public assets as well.
  New public bitmap artwork needs an explicit path-and-hash allowlist update
  after visual privacy review; do not bypass the gate for record images.

## Local setup

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8080`. Retrieve private setup access with `docker compose exec careledger python -m app.setup_link`; do not paste the result into issues or logs.

## Database changes

Schema changes require a reviewed migration. Never edit a deployed database by hand and never drop a database as part of development or tests.

## Pull requests

Describe the caregiver problem, the change, privacy impact, test evidence, and any migration or rollback steps. Maintainers decide when to publish or merge.

## GitHub Actions

CI never runs automatically on pushes or pull requests. To run it, open the repository's **Actions** tab, choose **CI**, select **Run workflow**, and confirm the run.

The default manual run performs the repository privacy gate, backend tests and
static checks, plus frontend unit tests, linting, and a production build. Select
**Run browser end-to-end and Docker checks** only when the fuller, higher-minute
suite is needed. Starting another run cancels an older run that is still in progress.
