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
