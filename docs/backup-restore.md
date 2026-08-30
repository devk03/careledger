# Backup and Restore

CareLedger treats recovery as part of patient safety. A backup is only useful after it has been authenticated, hash-checked, and restored successfully.

## What the portable export contains

- A consistent SQLite snapshot created with SQLite's online backup API.
- Every immutable source object referenced by the object manifest.
- A small manifest containing the format version, schema version, creation time, member type, exact byte size, and SHA-256 digest.

The archive is streamed directly through passphrase-based encryption. CareLedger does not create a temporary plaintext tar file.

The current format uses Argon2id to derive a key and AES-256-GCM to authenticate and encrypt independent 1 MiB chunks. The header and footer are authenticated. A wrong passphrase, modified byte, truncated file, unexpected member, unsafe path, object digest mismatch, or invalid SQLite snapshot makes restore fail closed.

## Operator procedure

The backup functions are implemented and tested as library code. The authenticated owner workflow and UI will be added after the initial database migration is approved. Until then, do not advertise backup as an end-user feature.

When the workflow is connected, it must follow this order:

1. Ask the signed-in owner to re-authenticate.
2. Collect a long, unique passphrase in a protected password field. Do not put it in a shell command, environment variable, URL, or log.
3. Create an online SQLite snapshot and export it with the immutable objects.
4. Inspect the encrypted export before reporting success.
5. Copy the encrypted file to storage that is not on the CareLedger host.
6. Perform a test restore into a new, empty location and compare the reported object hashes.
7. Record only operational metadata such as time, size, format version, and success. Do not log filenames, document text, passphrases, or patient details.

## Restore rules

- Stop writes before switching the live application to restored data.
- Restore only into a path that does not already exist.
- Never merge an archive into an existing data directory.
- Verify the encrypted stream, archive manifest, every member digest, the object manifest, `PRAGMA integrity_check`, and `PRAGMA foreign_key_check` before use.
- Keep the previous live volume unchanged until the restored instance has passed readiness and a caregiver has confirmed that expected records are present.
- A backup from a newer schema requires compatible application code. CareLedger must not auto-downgrade a database.

## Recovery practice

Keep more than one encrypted backup generation, with at least one off-host copy. Test recovery after upgrades and on a regular schedule. Store the backup passphrase separately from the encrypted backup; losing either makes recovery impossible.
