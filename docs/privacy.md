# Privacy model

Adeno is a hosted-first project under development. The current runnable community edition is operator-hosted software, not a finished public service. The public `/privacy` page describes these limits in plain language. Keep that page and this document synchronized when behavior changes.

The current server can read stored records. Complete end-to-end encrypted record storage is **not implemented**. Do not represent TLS, encrypted backups, or an encryption design as live E2EE. This document is not an operator-specific legal privacy notice or compliance certification.

## What stays local

Accounts, original records, derived pages, accepted claims, timelines, questions, audit events, and backups live in the operator-controlled `/data` volume.

## What can leave the server

When a caregiver confirms an AI explanation action, the selected original record (potentially the entire record), rendered pages, and task instructions can be sent to the configured provider: OpenRouter, OpenAI, or a compatible operator-configured endpoint. OpenRouter also routes requests to an underlying model provider. Do not promise that only a short excerpt leaves the installation. Server-configured API keys are not included in the browser bundle. Current patient-record extraction does not use live web search, hosted vector stores, remote MCP tools, or advertising analytics.

Retention and data-use policies depend on the configured provider and endpoint. Request settings alone do not provide a Business Associate Agreement, Zero Data Retention, or HIPAA compliance. Operators must evaluate their legal obligations, configure eligible provider agreements and data controls where required, secure hosting and backups, and obtain appropriate consent before processing protected health information.

The public GitHub counter requests fixed public repository statistics through the server, without forwarding health records or user credentials. Clicking the repository link navigates to GitHub under its own privacy practices. The isolated `ui-preview` mode uses fictional data, rejects writes, and does not call an AI provider; the public repository-statistics request remains enabled.

## Operator responsibilities and launch gates

The current build has no complete self-service account/record deletion workflow. The operator must document retention and removal of live records, derived information and backup copies before inviting real users. Password-encrypted backup exports do not encrypt the live store end to end.

Before hosted launch, publish the operator identity and contact, rights-request process, retention schedule, subprocessors, international processing details where applicable, and incident-response process. Confirm the implemented access/encryption design and obtain appropriate legal/security review. Individual family logins, permissions, external reminders, and full managed E2EE remain planned work, not present guarantees.

## Informational framing

Adeno is for personal understanding and organization, not medical advice, diagnosis, treatment recommendations, or emergencies. Reviewing an AI note does not establish medical accuracy. Keep this boundary in prompts, actions and UI, not just a footer. A disclaimer does not itself determine regulatory classification or eliminate privacy obligations; hosted launch requires review of the actual behavior and jurisdictions.

## Product promises

- Originals are content-addressed and never edited by application workflows.
- AI drafts cannot silently become accepted facts.
- Important claims retain source and page citations.
- Logs must exclude document content, personal names, access tokens, and API keys.
- The product must explain export, backup, retention, and deletion behavior before those actions run.
