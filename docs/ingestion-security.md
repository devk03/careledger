# Record admission boundary

Adeno treats every uploaded byte as hostile until validation finishes.

## Admission sequence

1. Stream to a randomly named `/data/quarantine` payload while enforcing the actual byte limit and computing SHA-256.
2. Detect PDF, JPEG, or PNG from fixed signatures. Browser MIME and filename extensions are untrusted cross-checks.
3. Normalize the display-only filename; it is never used as a filesystem path.
4. Run the configured malware-scanner interface. An unconfigured scanner is reported as `not_configured`, never `clean`.
5. Parse under strict structural limits. Reject encrypted/active PDFs, malformed containers, excessive pages/objects/geometry, animated images, pixel bombs, bad PNG CRCs, and trailing polyglot data.
6. Recompute the digest after inspection and again before promotion.
7. Promote accepted bytes into immutable content-addressed storage. Duplicate bytes share one object digest.

Quarantine transitions are written atomically to a local manifest. The current parser runs in-process; release hardening still requires a resource-limited, network-disabled worker. Network isolation must be enforced by the operating system or a separate constrained container, not claimed from Python alone.

Originals are never rendered inline as active PDFs. Future source access must be authenticated and use download disposition; previews will be inert derived images with independent hashes.

## TypeScript pilot boundary (not connected to uploads yet)

The TypeScript intake primitives require a previously durable, private parent directory. They stage a bounded copy of caller bytes in a private quarantine root and fsync both the file and its directory. Object storage rechecks the staged hash, writes a separate read-only pending inode, and atomically links fully verified bytes to the digest path without replacing an existing object. An opaque inspection result is required before the store accepts a stage, and unavailable scanning fails closed. `server/src/ingest/policy.ts` declares the pilot limits; only admission, PDF page count at the inspection gate, and image preflights currently enforce their respective subset. A `clamd` Unix-socket INSTREAM adapter is available, but no daemon is provisioned or connected to a route. The full document bytes are sent to that local daemon. Its socket must be in a trusted directory with no untrusted writable ancestor; the adapter checks the immediate parent and socket ownership, and deployment must protect the remaining path. The adapter caps concurrent scans (default two) and fails closed at capacity; route-level request throttling is still required. TypeScript PNG/JPEG preflights and Sharp full pixel decoding run inside a development Unix-socket worker that independently hashes exact request bytes. A separate [synthetic-only container preview](parser-sandbox-smoke.md) tests OS isolation, but the worker remains disconnected from Express, rejects PDFs, and has not been qualified on the deployment host. See the [parser-worker protocol](parser-worker-protocol.md) and [closed PDF gate](pdf-intake-gate.md). This is not a document/database publication and must not be connected to a route until PDF inspection, scanner provisioning, target-host sandbox validation, and authorization exist.

A crash can leave a private `pending-*` file; successful publication also leaves a read-only hard-link alias. `inventoryPendingObjects` reports linked aliases, unpublished pending files, and duplicate copies without deleting or serving them. Backup/restore and operator reconciliation must account for those states. The TypeScript pilot still needs a real scan/parse boundary, durable document transaction, and recovery drill before medical files are accepted.
