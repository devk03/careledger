# Contributing

Thank you for helping caregivers understand health records without losing the source truth.

## Ground rules

- Never use real patient records, identifiers, credentials, or screenshots in issues, tests, commits, or pull requests.
- Use synthetic fixtures only. A fixture must say that it is fictional.
- AI output is proposed evidence until a person reviews it beside the cited source.
- Keep medical language cautious. CareLedger organizes information; it does not diagnose or replace clinicians.
- Include tests for behavior changes and accessibility checks for interface changes.

## Local setup

```bash
cp .env.example .env
docker compose up --build
```

Open `http://localhost:8080`. The container prints a one-time setup URL on first boot.

## Database changes

Schema changes require a reviewed migration. Never edit a deployed database by hand and never drop a database as part of development or tests.

## Pull requests

Describe the caregiver problem, the change, privacy impact, test evidence, and any migration or rollback steps. Maintainers decide when to publish or merge.
