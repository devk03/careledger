# Expired-lease diagnostic — no release authority

`inspectExpiredManagedLeases` is an unmounted, read-only diagnostic over an already-migrated managed v10 database. It requires a read-only SQLite connection with the pinned managed schema. The caller must stop and drain **all** managed database and object writers, hold the fence for the inspection, and provide the matching private object tree. The function cannot prove that fence exists.

The report separates committed wire bytes from charged uncommitted day and non-day leases, groups expired charged leases by opaque household ID, and cross-checks its sum against v10's occupancy view. It uses the committed-reference reader and object inventory to surface missing/corrupt committed ciphertext and unreferenced inode-length totals. `asOfUnixSeconds` is an observation parameter for diagnostics and fictional time-boundary tests, not release authority or a care date.

It does **not** release quota, classify an individual pending file to an intent, delete or quarantine objects, measure allocated filesystem blocks, establish a physical-volume cap, or say an expired lease is safe to reclaim. Pending filenames are random and do not encode an intent, so future reconciliation must inventory the entire relevant household directory under a global writer fence and keep retained orphans physically charged.

Guarded fictional private-copy checks cover two families, one charged expired day lease, a fully paired charged draft lease, a one-pair global quota race, and a separate real ciphertext upload with one committed blob plus one abandoned lease. The tests distinguish a SQLite lock timeout from quota denial and confirm the committed lease is not double-counted. They do not test power loss, independent signed-head freshness, or production cleanup. No migration was created or applied for this diagnostic.

The [lease lifecycle proposal](managed-lease-lifecycle-proposal.md) describes the separately approved schema and storage evidence still required before any release operation or public intake.
