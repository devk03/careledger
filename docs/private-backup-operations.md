# Private backup commands

Candidate tooling for the trusted Hermes MVP. These commands do not initialize
or migrate a database, stop services, install a schedule, promote restored data,
delete files or overwrite outputs. The full application restore test is still
gated on migration approval. File-encryption tests alone do not prove recovery.

Build the server, then run `node server/dist/runPrivateBackup.js CONFIG_PATH`.
The only argument is an absolute private JSON configuration path. Its directory
must be owned by the executing UID with mode 0700; the config must be a regular
non-symlink file with mode 0600, at most 16 KiB. Unknown fields are rejected.
All output paths must be new and absolute, under existing private directories.
The command has a 15-minute deadline. Interrupted work remains private for
manual inspection; there is no automatic cleanup or retry.

## 1. Generate the identity off-host

Run on the owner's trusted device, not Hermes:

```json
{"action":"keygen","identityPath":"/private/off-host/backup-identity"}
```

The private identity is created once, mode 0600. Standard output contains only
the public age recipient. Keep the identity outside Git and off Hermes. Preserve
an independently recoverable secure copy; losing it makes encrypted backups
unrecoverable. The public recipient may be placed in the snapshot configuration.
Never put the private identity, login password or recovery codes in that config.

## 2. Collect an offline encrypted generation

Verify the exact application container and all application writers are stopped.
An operator assertion is required; the CLI cannot prove Docker writer state:

```json
{"action":"snapshot","sourceDbPath":"/data/case.sqlite","objectRoot":"/data/objects","recoveryPepperPath":"/data/secrets/recovery-pepper","snapshotRoot":"/backup-work/generation-unique","encryptedPath":"/encrypted/generation-unique.age","recipient":"PUBLIC_AGE_RECIPIENT","writersStopped":true}
```

Use the application UID. Mount source data read-only and private working/output
directories separately when using a one-off container. Snapshot working storage
must not overlap the database directory or original-object tree. No secrets or
record mount is required by the parser/scanner, which remain separate services.
The source database is opened read-only; the SQLite backup copy has browser
sessions revoked before encryption. Referenced originals and the recovery pepper
are included with exact lengths/digests. Agent grants and bootstrap tokens are
excluded. Private plaintext snapshot/bundle copies remain retained on the source
device; they must never be copied to a public directory or committed.

Only successful completion prints ciphertext `sha256` and `bytes`. Save that
receipt on the off-host device, transfer the encrypted generation over the
authorized SSH connection and independently verify its digest and size there.
Pin the trusted receipt off-host; computing a new hash from an untrusted archive
at restore time does not establish authenticity. Keep prior successful encrypted
generations until the new transfer and restore verification have succeeded.

## 3. Restore off-host into new private storage

Run on the trusted device holding the identity:

```json
{"action":"restore","encryptedPath":"/private/off-host/generation-unique.age","expectedSha256":"PINNED_CIPHERTEXT_SHA256","identityPath":"/private/off-host/backup-identity","workRoot":"/private/off-host/restore-work-unique","destinationRoot":"/private/off-host/restore-unique"}
```

The CLI verifies the pinned ciphertext digest, authenticates age, checks bundle
members and application state, and publishes only `destinationRoot/data` after
all gates pass. It refuses an existing destination and never changes live data.
Successful output is `{"action":"restore","verified":true}`; no paths, key,
record text or account identifiers are printed. A success is an offline restore,
not permission to activate the recovered application.

Before activation, review recovered accounts and rotate relevant credentials and
recovery codes. A backup preserves account state at snapshot time and cannot know
which accounts/passwords were revoked afterward. Session revocation and excluded
agent grants prevent restoring those sessions/connections, but do not replace
that account review. Keep live/original data intact, copy only the recovered data
tree through the authorized private channel, preserve ownership/modes, and verify
the exact reviewed release, approved history/citations and new sign-in/revocation
flow before switching the application to the recovered directory. Never transfer
the off-host identity to Hermes for convenience.
