# Security Policy and Privacy Baseline

## Scope

Health records, OCR, extracted claims, prompts, responses, filenames, audit events, backups, exports, and notifications may contain sensitive health information.

Adeno is not HIPAA-compliant out of the box and provides no BAA. Operators are responsible for deployment, contracts, policies, access control, retention, and legal compliance.

## Release-blocking controls

### Authentication and authorization

- No default account or public signup.
- One-time expiring setup token; setup closes permanently after owner creation.
- Argon2id password hashing, recovery codes, secure HttpOnly/SameSite cookies, CSRF protection, and throttling.
- Server-side authorization on every care profile, document, page, citation, export, preview, and search result.

### PHI boundary

- No analytics, session replay, third-party telemetry, email/SMS detail, or remote font dependency by default.
- Browser never receives the OpenAI key or calls OpenAI directly.
- No PHI in URLs, routine logs, exception messages, or notification text.
- Research queries are separate, de-identified, visible to the user, and approved before sending.

### Upload and parser safety

- Initially allow PDF, JPEG, and PNG only.
- Validate magic bytes, MIME, size, page count, and decoded pixel count.
- Store randomized/content-addressed files outside the web root.
- Quarantine and scan before parsing.
- Parse in a non-root, network-disabled worker with CPU, memory, and time limits.
- Never render raw HTML/SVG or execute active PDF content.

### Prompt-injection containment

- Documents are evidence, never instructions.
- Extraction models receive no mutation, deletion, shell, messaging, or browsing tools.
- AI output remains a proposal until human approval.
- Citationless medical claims fail closed.
- Tests include malicious documents containing fake system prompts, exfiltration requests, links, and tool instructions.

### OpenAI boundary

- Always set `store: false` and `background: false`.
- Avoid hosted Conversations, Assistants, vector stores, persistent Files, MCP, and live web search for patient documents in the MVP.
- Do not claim that an API key enables Zero Data Retention or HIPAA eligibility.

### Backup and restore boundary

- Portable exports use a passphrase-derived key and authenticated, independently encrypted chunks; no plaintext archive is written to disk.
- The encrypted header, archive manifest, member sizes, member SHA-256 digests, and final stream digest are verified before a restore is accepted.
- Restore writes only regular files with controlled relative paths into a newly created staging directory, verifies the SQLite snapshot and object manifest, and publishes the restored directory atomically.
- Passphrases must be collected through an interactive or protected application input. Never place one in a command argument, environment variable, URL, log, analytics event, or support bundle.
- Operators must keep at least one tested, encrypted copy off the application host. Encryption does not replace access control, retention policy, or restore practice.

## Before public promotion

- TLS/HSTS, strict CSP, same-origin CORS, sanitized Markdown, upload/AI rate limits, restricted egress, and non-root/read-only container.
- Protected generated secrets, documented rotation, encrypted portable exports, and tested off-host restore instructions.
- Append-only audit events without PHI content.
- Complete export and re-authenticated deletion workflows.
- Locked dependencies/images, SBOM, SAST, secret/dependency/container scanning, and signed releases.
- Private vulnerability-reporting channel and supported-version policy.

## Reporting a vulnerability

Do not open a public issue containing patient data, credentials, exploit details, or sensitive logs. A private reporting address will be added before the first public release.
