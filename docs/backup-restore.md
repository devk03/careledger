# Backup and Restore

CareLedger treats recovery as part of patient safety. A backup is only useful after it has been authenticated, hash-checked, and restored successfully.

## What the portable export contains

- A consistent SQLite snapshot created with SQLite's online backup API.
- Every immutable source object referenced by the object manifest.
- The 32-byte local recovery-code pepper, so unused owner recovery codes still work after restore.
- A small manifest containing the format version, schema version, creation time, member type, exact byte size, and SHA-256 digest.

The archive is streamed directly through passphrase-based encryption. CareLedger does not create a temporary plaintext tar file.

The current format uses Argon2id to derive a key and AES-256-GCM to authenticate and encrypt independent 1 MiB chunks. The header and footer are authenticated. A wrong passphrase, modified byte, truncated file, unexpected member, unsafe path, object digest mismatch, or invalid SQLite snapshot makes restore fail closed.

## Owner procedure

Open **Back up this workspace** from the care dashboard. The owner must enter the current CareLedger account password and a separate backup passphrase of at least 12 characters. CareLedger then:

1. Re-authenticates the active owner and validates CSRF/origin controls.
2. Creates a consistent online SQLite snapshot.
3. Verifies every immutable source object and includes the recovery-code pepper.
4. Encrypts and authenticates the archive, inspects it, and only then starts the download.
5. Keeps an encrypted server-side copy in `/data/backups`; the passphrase is never stored.

After download:

1. Copy the encrypted file to storage that is not on the CareLedger host.
2. Store the passphrase separately from the file.
3. Perform a test restore into a new, empty location and compare the reported object hashes.
4. Record only operational metadata such as time, size, format version, and success. Do not log filenames, document text, passphrases, or patient details.

## Restore rules

- Stop writes before switching the live application to restored data.
- Restore only into a path that does not already exist.
- Never merge an archive into an existing data directory.
- Verify the encrypted stream, archive manifest, every member digest, the object manifest, `PRAGMA integrity_check`, and `PRAGMA foreign_key_check` before use.
- Keep the previous live volume unchanged until the restored instance has passed readiness and a caregiver has confirmed that expected records are present.
- A backup from a newer schema requires compatible application code. CareLedger must not auto-downgrade a database.

Restore is intentionally not a live-web action. It must never overwrite or merge into the current `/data` volume. Use the tested restore library/operator procedure against a new directory, verify it, and switch deployment storage only after a caregiver confirms the result.

## Recovery practice

Keep more than one encrypted backup generation, with at least one off-host copy. Test recovery after upgrades and on a regular schedule. Store the backup passphrase separately from the encrypted backup; losing either makes recovery impossible.
