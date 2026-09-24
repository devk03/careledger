# Local stress checks

These checks use only fictional data. The HTTP harness starts its own Express server on an ephemeral `127.0.0.1` port; it never contacts a hosted deployment or the existing application database. The ingest harness writes small fictional files to a new OS temporary directory and leaves them there. Do not point either harness at real records.

From `server/`, run `npm run stress:http` and `npm run stress:ingest`. Each command builds the TypeScript server first. The HTTP check is bounded at 12,200 requests across concurrency levels 5, 20 and 80: a mixed authorized/denied phase and a separate authorized-reads-only phase. The ingest check admits 5,000 in-memory 32 KiB fictional files and stages 100 such files with concurrency 10, then verifies exact bytes and private file modes. Neither command registers or applies the unregistered care-day migration.

## Baseline on 2026-09-23

| Scenario | Result |
| --- | --- |
| Python tests | 136 passed |
| Express/TypeScript tests | 29 passed; typecheck passed |
| React unit tests | 44 passed; production build passed |
| Chromium end-to-end | 63 passed |
| Synthetic HTTP, mixed, 20 concurrent / 2,000 requests | 0 failures; ~4,547 requests/sec; p95 9.1 ms; p99 19.1 ms |
| Synthetic HTTP, mixed, 80 concurrent / 5,000 requests | 0 failures; ~8,291 requests/sec; p95 11.8 ms; p99 50.4 ms |
| Synthetic HTTP, authorized-only, 80 concurrent / 5,000 requests | 0 failures; ~8,381 requests/sec; p95 11.3 ms; p99 14.1 ms; process RSS ~193 MiB |
| Synthetic admission | 5,000 files of 32,826 bytes; 0 failures |
| Synthetic staging | 100 files, 10 concurrent; exact bytes and `0600` mode verified; p95 47.9 ms, p99 51.9 ms |

These numbers are machine-specific, short-run baselines, not service-level promises. The Express load harness uses an in-memory fictional repository, not the eventual durable database, authentication service, object storage, encryption, OCR or MCP transport. The ingest path measures admission and quarantine staging, not scanning, parsing, promotion or a real web upload. The UI end-to-end tests use the isolated synthetic preview, not a production backend. A complete hosted capacity/security assessment remains outstanding, including long-duration soak tests, large-file limits, rate limiting, multi-family isolation, encrypted-sync behavior, and failure/recovery under resource pressure.
