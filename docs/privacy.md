# Privacy model

CareLedger is self-hosted software, not a hosted medical service.

## What stays local

Accounts, original records, derived pages, accepted claims, timelines, questions, audit events, and backups live in the operator-controlled `/data` volume.

## What can leave the server

When a caregiver chooses an AI action, the smallest necessary record pages and task instructions are sent from the server to the configured OpenAI API. API keys never enter the browser bundle. Patient-record extraction does not use live web search, hosted vector stores, remote MCP tools, or analytics.

CareLedger requests `store: false`, but that setting alone does not provide a Business Associate Agreement, Zero Data Retention, or HIPAA compliance. Operators must evaluate their legal obligations, configure an eligible provider agreement and data controls where required, secure hosting and backups, and obtain appropriate consent before processing protected health information.

## Product promises

- Originals are content-addressed and never edited by application workflows.
- AI drafts cannot silently become accepted facts.
- Important claims retain source and page citations.
- Logs must exclude document content, personal names, access tokens, and API keys.
- The product must explain export, backup, retention, and deletion behavior before those actions run.
