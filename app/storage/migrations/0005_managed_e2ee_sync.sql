CREATE UNIQUE INDEX users_household_id_unique
ON users (household_id, id);

CREATE UNIQUE INDEX sessions_user_id_unique
ON sessions (user_id, id);

CREATE TABLE managed_household_state (
    household_id TEXT PRIMARY KEY
        REFERENCES households(id) ON DELETE RESTRICT,
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    current_key_epoch INTEGER NOT NULL DEFAULT 0 CHECK (current_key_epoch >= 0),
    head_sequence INTEGER NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
    head_manifest_sha256 BLOB,
    ciphertext_bytes INTEGER NOT NULL DEFAULT 0 CHECK (ciphertext_bytes >= 0),
    quota_bytes INTEGER NOT NULL CHECK (quota_bytes BETWEEN 1048576 AND 1099511627776),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    CHECK (ciphertext_bytes <= quota_bytes),
    CHECK (
        (head_sequence = 0 AND head_manifest_sha256 IS NULL)
        OR (
            head_sequence > 0
            AND head_manifest_sha256 IS NOT NULL
            AND length(head_manifest_sha256) = 32
        )
    ),
    UNIQUE (household_id, current_key_epoch)
) STRICT;

CREATE TABLE managed_devices (
    household_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
    encryption_algorithm TEXT NOT NULL CHECK (encryption_algorithm = 'x25519'),
    encryption_public_key BLOB NOT NULL CHECK (length(encryption_public_key) = 32),
    signing_algorithm TEXT NOT NULL CHECK (signing_algorithm = 'ed25519'),
    signing_public_key BLOB NOT NULL CHECK (length(signing_public_key) = 32),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    activated_at INTEGER,
    revoked_at INTEGER,
    PRIMARY KEY (household_id, id),
    UNIQUE (household_id, encryption_public_key),
    UNIQUE (household_id, signing_public_key),
    FOREIGN KEY (household_id, user_id)
        REFERENCES users(household_id, id) ON DELETE RESTRICT,
    CHECK (
        (state = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
        OR (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
        OR (state = 'revoked' AND revoked_at IS NOT NULL)
    )
) STRICT;

CREATE TABLE managed_enrollment_challenges (
    household_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    token_sha256 BLOB NOT NULL CHECK (length(token_sha256) = 32),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    consumed_at INTEGER,
    PRIMARY KEY (household_id, id),
    UNIQUE (token_sha256),
    FOREIGN KEY (household_id, user_id)
        REFERENCES users(household_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (user_id, session_id)
        REFERENCES sessions(user_id, id) ON DELETE RESTRICT,
    CHECK (expires_at <= created_at + 600),
    CHECK (consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at)
) STRICT;

CREATE TABLE managed_device_grants (
    household_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'admin')),
    state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
    granted_by_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    granted_at INTEGER NOT NULL CHECK (granted_at > 0),
    revoked_at INTEGER,
    PRIMARY KEY (household_id, device_id),
    UNIQUE (household_id, granted_by_device_id, device_counter),
    FOREIGN KEY (household_id, device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, granted_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    CHECK (
        (state = 'active' AND revoked_at IS NULL)
        OR (state = 'revoked' AND revoked_at IS NOT NULL)
    )
) STRICT;

CREATE TABLE managed_key_epochs (
    household_id TEXT NOT NULL,
    key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
    previous_key_epoch INTEGER,
    key_commitment BLOB NOT NULL CHECK (length(key_commitment) = 32),
    created_by_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, key_epoch),
    UNIQUE (household_id, created_by_device_id, device_counter),
    FOREIGN KEY (household_id, created_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    CHECK (
        (key_epoch = 1 AND previous_key_epoch IS NULL)
        OR (key_epoch > 1 AND previous_key_epoch = key_epoch - 1)
    )
) STRICT;

CREATE TABLE managed_device_key_envelopes (
    household_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    device_id TEXT NOT NULL,
    key_epoch INTEGER NOT NULL,
    suite TEXT NOT NULL CHECK (suite = 'hpke-x25519-hkdf-sha256-aes256gcm-v1'),
    encapsulated_key BLOB NOT NULL CHECK (length(encapsulated_key) = 32),
    envelope_ciphertext BLOB NOT NULL CHECK (length(envelope_ciphertext) BETWEEN 48 AND 4096),
    envelope_sha256 BLOB NOT NULL CHECK (length(envelope_sha256) = 32),
    wrapped_key_fingerprint BLOB NOT NULL CHECK (length(wrapped_key_fingerprint) = 32),
    created_by_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, id),
    UNIQUE (household_id, device_id, key_epoch),
    UNIQUE (household_id, created_by_device_id, device_counter),
    FOREIGN KEY (household_id, key_epoch)
        REFERENCES managed_key_epochs(household_id, key_epoch) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, device_id)
        REFERENCES managed_device_grants(household_id, device_id) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, created_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_recovery_envelopes (
    household_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    key_epoch INTEGER NOT NULL,
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    kdf_profile TEXT NOT NULL CHECK (kdf_profile = 'argon2id-19mib-2-v1'),
    salt BLOB NOT NULL CHECK (length(salt) = 16),
    envelope_id BLOB NOT NULL CHECK (length(envelope_id) = 16),
    iv BLOB NOT NULL CHECK (length(iv) = 12),
    envelope_ciphertext BLOB NOT NULL CHECK (length(envelope_ciphertext) = 48),
    envelope_sha256 BLOB NOT NULL CHECK (length(envelope_sha256) = 32),
    created_by_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, id),
    UNIQUE (household_id, key_epoch),
    UNIQUE (household_id, envelope_id),
    UNIQUE (household_id, created_by_device_id, device_counter),
    FOREIGN KEY (household_id, key_epoch)
        REFERENCES managed_key_epochs(household_id, key_epoch) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, created_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_nonces (
    household_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    key_epoch INTEGER NOT NULL,
    nonce BLOB NOT NULL CHECK (length(nonce) = 12),
    purpose TEXT NOT NULL CHECK (purpose IN ('blob_chunk', 'manifest')),
    scope_id TEXT NOT NULL CHECK (
        length(scope_id) BETWEEN 1 AND 160 AND scope_id NOT GLOB '*[^A-Za-z0-9_:-]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, id),
    UNIQUE (household_id, key_epoch, nonce),
    UNIQUE (household_id, purpose, scope_id),
    FOREIGN KEY (household_id, key_epoch)
        REFERENCES managed_key_epochs(household_id, key_epoch) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_blob_uploads (
    household_id TEXT NOT NULL,
    blob_id TEXT NOT NULL CHECK (
        length(blob_id) BETWEEN 1 AND 64 AND blob_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    opaque_object_id TEXT NOT NULL CHECK (
        length(opaque_object_id) BETWEEN 1 AND 64
        AND opaque_object_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    object_version INTEGER NOT NULL CHECK (object_version > 0),
    key_epoch INTEGER NOT NULL,
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    plaintext_size INTEGER NOT NULL CHECK (plaintext_size BETWEEN 0 AND 104857600),
    ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size > 0),
    chunk_size INTEGER NOT NULL CHECK (chunk_size = 1048576),
    chunk_count INTEGER NOT NULL CHECK (chunk_count BETWEEN 1 AND 100),
    created_by_device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
    PRIMARY KEY (household_id, blob_id),
    FOREIGN KEY (household_id, key_epoch)
        REFERENCES managed_key_epochs(household_id, key_epoch) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, created_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    CHECK (expires_at <= created_at + 86400),
    CHECK (
        chunk_count = CASE
            WHEN plaintext_size = 0 THEN 1
            ELSE (plaintext_size + chunk_size - 1) / chunk_size
        END
    ),
    CHECK (ciphertext_size = plaintext_size + (chunk_count * 16))
) STRICT;

CREATE TABLE managed_blob_chunks (
    household_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    nonce_id TEXT NOT NULL,
    ciphertext_size INTEGER NOT NULL CHECK (ciphertext_size BETWEEN 16 AND 1048592),
    ciphertext_sha256 BLOB NOT NULL CHECK (length(ciphertext_sha256) = 32),
    storage_object_id TEXT NOT NULL CHECK (
        length(storage_object_id) BETWEEN 1 AND 96
        AND storage_object_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, blob_id, chunk_index),
    UNIQUE (household_id, storage_object_id),
    FOREIGN KEY (household_id, blob_id)
        REFERENCES managed_blob_uploads(household_id, blob_id) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, nonce_id)
        REFERENCES managed_nonces(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_committed_blobs (
    household_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    opaque_object_id TEXT NOT NULL,
    object_version INTEGER NOT NULL CHECK (object_version > 0),
    ciphertext_root BLOB NOT NULL CHECK (length(ciphertext_root) = 32),
    committed_by_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    committed_at INTEGER NOT NULL CHECK (committed_at > 0),
    PRIMARY KEY (household_id, blob_id),
    UNIQUE (household_id, opaque_object_id, object_version),
    UNIQUE (household_id, committed_by_device_id, device_counter),
    FOREIGN KEY (household_id, blob_id)
        REFERENCES managed_blob_uploads(household_id, blob_id) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, committed_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_manifests (
    household_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    key_epoch INTEGER NOT NULL,
    previous_manifest_sha256 BLOB,
    nonce_id TEXT NOT NULL,
    ciphertext BLOB NOT NULL CHECK (length(ciphertext) BETWEEN 17 AND 16777216),
    manifest_sha256 BLOB NOT NULL CHECK (length(manifest_sha256) = 32),
    author_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, sequence),
    UNIQUE (household_id, id),
    UNIQUE (household_id, manifest_sha256),
    UNIQUE (household_id, author_device_id, device_counter),
    FOREIGN KEY (household_id, key_epoch)
        REFERENCES managed_key_epochs(household_id, key_epoch) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, nonce_id)
        REFERENCES managed_nonces(household_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, author_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    CHECK (
        (sequence = 1 AND previous_manifest_sha256 IS NULL)
        OR (sequence > 1 AND previous_manifest_sha256 IS NOT NULL
            AND length(previous_manifest_sha256) = 32)
    )
) STRICT;

CREATE TABLE managed_device_checkpoints (
    household_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    observed_sequence INTEGER NOT NULL CHECK (observed_sequence > 0),
    observed_manifest_sha256 BLOB NOT NULL CHECK (length(observed_manifest_sha256) = 32),
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    PRIMARY KEY (household_id, device_id, observed_sequence),
    UNIQUE (household_id, device_id, device_counter),
    FOREIGN KEY (household_id, device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, observed_sequence)
        REFERENCES managed_manifests(household_id, sequence) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_deletion_tombstones (
    household_id TEXT NOT NULL,
    id TEXT NOT NULL CHECK (
        length(id) BETWEEN 1 AND 64 AND id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    target_kind TEXT NOT NULL CHECK (target_kind IN ('blob', 'opaque_object', 'device_grant')),
    target_id TEXT NOT NULL CHECK (
        length(target_id) BETWEEN 1 AND 96 AND target_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    effective_sequence INTEGER NOT NULL CHECK (effective_sequence > 0),
    created_by_device_id TEXT NOT NULL,
    device_counter INTEGER NOT NULL CHECK (device_counter > 0),
    tombstone_hash BLOB NOT NULL CHECK (length(tombstone_hash) = 32),
    signature BLOB NOT NULL CHECK (length(signature) = 64),
    created_at INTEGER NOT NULL CHECK (created_at > 0),
    retain_until INTEGER NOT NULL CHECK (retain_until > created_at),
    PRIMARY KEY (household_id, id),
    UNIQUE (household_id, target_kind, target_id),
    UNIQUE (household_id, created_by_device_id, device_counter),
    FOREIGN KEY (household_id, effective_sequence)
        REFERENCES managed_manifests(household_id, sequence) ON DELETE RESTRICT,
    FOREIGN KEY (household_id, created_by_device_id)
        REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
    CHECK (retain_until >= created_at + 2592000)
) STRICT;

CREATE INDEX managed_devices_user
ON managed_devices (household_id, user_id, state);

CREATE INDEX managed_envelopes_device_epoch
ON managed_device_key_envelopes (household_id, device_id, key_epoch DESC);

CREATE INDEX managed_blob_versions
ON managed_committed_blobs (household_id, opaque_object_id, object_version DESC);

CREATE INDEX managed_manifests_recent
ON managed_manifests (household_id, sequence DESC);

CREATE INDEX managed_tombstones_sequence
ON managed_deletion_tombstones (household_id, effective_sequence);

CREATE TRIGGER managed_devices_identity_immutable
BEFORE UPDATE ON managed_devices
WHEN NEW.household_id != OLD.household_id
  OR NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id
  OR NEW.encryption_algorithm != OLD.encryption_algorithm
  OR NEW.encryption_public_key != OLD.encryption_public_key
  OR NEW.signing_algorithm != OLD.signing_algorithm
  OR NEW.signing_public_key != OLD.signing_public_key
  OR NEW.created_at != OLD.created_at
BEGIN
    SELECT RAISE(ABORT, 'managed device identity is immutable');
END;

CREATE TRIGGER managed_devices_transition_guard
BEFORE UPDATE ON managed_devices
WHEN NOT (
    (OLD.state = 'pending' AND NEW.state IN ('pending', 'active', 'revoked'))
    OR (OLD.state = 'active' AND NEW.state IN ('active', 'revoked'))
    OR (OLD.state = 'revoked' AND NEW.state = 'revoked')
)
BEGIN
    SELECT RAISE(ABORT, 'managed device state cannot move backward');
END;

CREATE TRIGGER managed_devices_no_delete
BEFORE DELETE ON managed_devices
BEGIN
    SELECT RAISE(ABORT, 'managed devices are append-only');
END;

CREATE TRIGGER managed_challenge_update_guard
BEFORE UPDATE ON managed_enrollment_challenges
WHEN NEW.household_id != OLD.household_id
  OR NEW.id != OLD.id
  OR NEW.user_id != OLD.user_id
  OR NEW.session_id != OLD.session_id
  OR NEW.token_sha256 != OLD.token_sha256
  OR NEW.created_at != OLD.created_at
  OR NEW.expires_at != OLD.expires_at
  OR OLD.consumed_at IS NOT NULL
  OR NEW.consumed_at IS NULL
BEGIN
    SELECT RAISE(ABORT, 'managed enrollment challenge is immutable or consumed');
END;

CREATE TRIGGER managed_challenge_no_delete
BEFORE DELETE ON managed_enrollment_challenges
BEGIN
    SELECT RAISE(ABORT, 'managed enrollment challenges are append-only');
END;

CREATE TRIGGER managed_grant_identity_immutable
BEFORE UPDATE ON managed_device_grants
WHEN NEW.household_id != OLD.household_id
  OR NEW.device_id != OLD.device_id
  OR NEW.role != OLD.role
  OR NEW.granted_by_device_id != OLD.granted_by_device_id
  OR NEW.device_counter != OLD.device_counter
  OR NEW.signature != OLD.signature
  OR NEW.granted_at != OLD.granted_at
  OR (OLD.state = 'revoked' AND NEW.state != 'revoked')
BEGIN
    SELECT RAISE(ABORT, 'managed device grant is immutable');
END;

CREATE TRIGGER managed_grant_no_delete
BEFORE DELETE ON managed_device_grants
BEGIN
    SELECT RAISE(ABORT, 'managed device grants are append-only');
END;

CREATE TRIGGER managed_key_epoch_guard
BEFORE INSERT ON managed_key_epochs
WHEN NOT EXISTS (
    SELECT 1
    FROM managed_household_state AS state
    JOIN managed_devices AS device
      ON device.household_id = NEW.household_id
     AND device.id = NEW.created_by_device_id
     AND device.state = 'active'
    JOIN managed_device_grants AS grant_row
      ON grant_row.household_id = NEW.household_id
     AND grant_row.device_id = NEW.created_by_device_id
     AND grant_row.state = 'active'
     AND grant_row.role = 'admin'
    WHERE state.household_id = NEW.household_id
      AND NEW.key_epoch = state.current_key_epoch + 1
      AND (
          (state.current_key_epoch = 0 AND NEW.previous_key_epoch IS NULL)
          OR NEW.previous_key_epoch = state.current_key_epoch
      )
)
BEGIN
    SELECT RAISE(ABORT, 'managed key epoch is not authorized or sequential');
END;

CREATE TRIGGER managed_key_epoch_advance
AFTER INSERT ON managed_key_epochs
BEGIN
    UPDATE managed_household_state
    SET current_key_epoch = NEW.key_epoch, updated_at = NEW.created_at
    WHERE household_id = NEW.household_id;
END;

CREATE TRIGGER managed_blob_chunk_guard
BEFORE INSERT ON managed_blob_chunks
WHEN NOT EXISTS (
    SELECT 1
    FROM managed_blob_uploads AS upload
    JOIN managed_nonces AS nonce_row
      ON nonce_row.household_id = NEW.household_id
     AND nonce_row.id = NEW.nonce_id
     AND nonce_row.key_epoch = upload.key_epoch
     AND nonce_row.purpose = 'blob_chunk'
     AND nonce_row.scope_id = upload.blob_id || ':' || NEW.chunk_index
    WHERE upload.household_id = NEW.household_id
      AND upload.blob_id = NEW.blob_id
      AND NEW.chunk_index < upload.chunk_count
      AND NEW.ciphertext_size = (
          CASE
              WHEN NEW.chunk_index < upload.chunk_count - 1
              THEN upload.chunk_size + 16
              ELSE upload.plaintext_size - (upload.chunk_size * (upload.chunk_count - 1)) + 16
          END
      )
)
BEGIN
    SELECT RAISE(ABORT, 'managed blob chunk scope or size is invalid');
END;

CREATE TRIGGER managed_blob_commit_guard
BEFORE INSERT ON managed_committed_blobs
WHEN NOT EXISTS (
    SELECT 1
    FROM managed_blob_uploads AS upload
    JOIN managed_household_state AS state
      ON state.household_id = upload.household_id
    JOIN managed_devices AS device
      ON device.household_id = upload.household_id
     AND device.id = NEW.committed_by_device_id
     AND device.state = 'active'
    JOIN managed_device_grants AS grant_row
      ON grant_row.household_id = upload.household_id
     AND grant_row.device_id = NEW.committed_by_device_id
     AND grant_row.state = 'active'
     AND grant_row.role IN ('writer', 'admin')
    WHERE upload.household_id = NEW.household_id
      AND upload.blob_id = NEW.blob_id
      AND upload.opaque_object_id = NEW.opaque_object_id
      AND upload.object_version = NEW.object_version
      AND upload.key_epoch = state.current_key_epoch
      AND NEW.committed_at <= upload.expires_at
      AND state.ciphertext_bytes + upload.ciphertext_size <= state.quota_bytes
      AND (SELECT COUNT(*) FROM managed_blob_chunks AS chunk
           WHERE chunk.household_id = upload.household_id
             AND chunk.blob_id = upload.blob_id) = upload.chunk_count
      AND (SELECT COALESCE(MIN(chunk.chunk_index), -1) FROM managed_blob_chunks AS chunk
           WHERE chunk.household_id = upload.household_id
             AND chunk.blob_id = upload.blob_id) = 0
      AND (SELECT COALESCE(MAX(chunk.chunk_index), -1) FROM managed_blob_chunks AS chunk
           WHERE chunk.household_id = upload.household_id
             AND chunk.blob_id = upload.blob_id) = upload.chunk_count - 1
      AND (SELECT COALESCE(SUM(chunk.ciphertext_size), 0) FROM managed_blob_chunks AS chunk
           WHERE chunk.household_id = upload.household_id
             AND chunk.blob_id = upload.blob_id) = upload.ciphertext_size
      AND NOT EXISTS (
          SELECT 1 FROM managed_deletion_tombstones AS tombstone
          WHERE tombstone.household_id = upload.household_id
            AND tombstone.target_kind = 'opaque_object'
            AND tombstone.target_id = upload.opaque_object_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'managed blob commit is incomplete or unauthorized');
END;

CREATE TRIGGER managed_blob_commit_accounting
AFTER INSERT ON managed_committed_blobs
BEGIN
    UPDATE managed_household_state
    SET ciphertext_bytes = ciphertext_bytes + (
        SELECT ciphertext_size FROM managed_blob_uploads
        WHERE household_id = NEW.household_id AND blob_id = NEW.blob_id
    ), updated_at = NEW.committed_at
    WHERE household_id = NEW.household_id;
END;

CREATE TRIGGER managed_manifest_guard
BEFORE INSERT ON managed_manifests
WHEN NOT EXISTS (
    SELECT 1
    FROM managed_household_state AS state
    JOIN managed_devices AS device
      ON device.household_id = NEW.household_id
     AND device.id = NEW.author_device_id
     AND device.state = 'active'
    JOIN managed_device_grants AS grant_row
      ON grant_row.household_id = NEW.household_id
     AND grant_row.device_id = NEW.author_device_id
     AND grant_row.state = 'active'
     AND grant_row.role IN ('writer', 'admin')
    JOIN managed_nonces AS nonce_row
      ON nonce_row.household_id = NEW.household_id
     AND nonce_row.id = NEW.nonce_id
     AND nonce_row.key_epoch = NEW.key_epoch
     AND nonce_row.purpose = 'manifest'
     AND nonce_row.scope_id = NEW.id
    WHERE state.household_id = NEW.household_id
      AND NEW.key_epoch = state.current_key_epoch
      AND NEW.sequence = state.head_sequence + 1
      AND (
          (state.head_sequence = 0 AND NEW.previous_manifest_sha256 IS NULL)
          OR NEW.previous_manifest_sha256 = state.head_manifest_sha256
      )
)
BEGIN
    SELECT RAISE(ABORT, 'managed manifest compare-and-swap failed');
END;

CREATE TRIGGER managed_manifest_advance
AFTER INSERT ON managed_manifests
BEGIN
    UPDATE managed_household_state
    SET head_sequence = NEW.sequence,
        head_manifest_sha256 = NEW.manifest_sha256,
        updated_at = NEW.created_at
    WHERE household_id = NEW.household_id;
END;

CREATE TRIGGER managed_checkpoint_guard
BEFORE INSERT ON managed_device_checkpoints
WHEN NOT EXISTS (
    SELECT 1
    FROM managed_manifests AS manifest
    JOIN managed_devices AS device
      ON device.household_id = NEW.household_id
     AND device.id = NEW.device_id
     AND device.state = 'active'
    WHERE manifest.household_id = NEW.household_id
      AND manifest.sequence = NEW.observed_sequence
      AND manifest.manifest_sha256 = NEW.observed_manifest_sha256
      AND NEW.observed_sequence > COALESCE((
          SELECT MAX(previous.observed_sequence)
          FROM managed_device_checkpoints AS previous
          WHERE previous.household_id = NEW.household_id
            AND previous.device_id = NEW.device_id
      ), 0)
)
BEGIN
    SELECT RAISE(ABORT, 'managed checkpoint is stale or invalid');
END;

CREATE TRIGGER managed_tombstone_guard
BEFORE INSERT ON managed_deletion_tombstones
WHEN NOT EXISTS (
    SELECT 1
    FROM managed_manifests AS manifest
    JOIN managed_devices AS device
      ON device.household_id = NEW.household_id
     AND device.id = NEW.created_by_device_id
     AND device.state = 'active'
    JOIN managed_device_grants AS grant_row
      ON grant_row.household_id = NEW.household_id
     AND grant_row.device_id = NEW.created_by_device_id
     AND grant_row.state = 'active'
     AND grant_row.role IN ('writer', 'admin')
    WHERE manifest.household_id = NEW.household_id
      AND manifest.sequence = NEW.effective_sequence
)
BEGIN
    SELECT RAISE(ABORT, 'managed tombstone is unauthorized or uncommitted');
END;

CREATE TRIGGER managed_state_guard
BEFORE UPDATE ON managed_household_state
WHEN NEW.household_id != OLD.household_id
  OR NEW.format_version != OLD.format_version
  OR NEW.current_key_epoch < OLD.current_key_epoch
  OR NEW.head_sequence < OLD.head_sequence
  OR NEW.ciphertext_bytes < OLD.ciphertext_bytes
  OR NEW.quota_bytes != OLD.quota_bytes
  OR NEW.created_at != OLD.created_at
  OR NEW.updated_at < OLD.updated_at
BEGIN
    SELECT RAISE(ABORT, 'managed household state cannot move backward');
END;

CREATE TRIGGER managed_state_no_delete
BEFORE DELETE ON managed_household_state
BEGIN
    SELECT RAISE(ABORT, 'managed household state is append-only');
END;

CREATE TRIGGER managed_key_epochs_immutable_update
BEFORE UPDATE ON managed_key_epochs BEGIN
    SELECT RAISE(ABORT, 'managed key epochs are immutable');
END;
CREATE TRIGGER managed_key_epochs_immutable_delete
BEFORE DELETE ON managed_key_epochs BEGIN
    SELECT RAISE(ABORT, 'managed key epochs are immutable');
END;

CREATE TRIGGER managed_device_envelopes_immutable_update
BEFORE UPDATE ON managed_device_key_envelopes BEGIN
    SELECT RAISE(ABORT, 'managed device envelopes are immutable');
END;
CREATE TRIGGER managed_device_envelopes_immutable_delete
BEFORE DELETE ON managed_device_key_envelopes BEGIN
    SELECT RAISE(ABORT, 'managed device envelopes are immutable');
END;

CREATE TRIGGER managed_recovery_envelopes_immutable_update
BEFORE UPDATE ON managed_recovery_envelopes BEGIN
    SELECT RAISE(ABORT, 'managed recovery envelopes are immutable');
END;
CREATE TRIGGER managed_recovery_envelopes_immutable_delete
BEFORE DELETE ON managed_recovery_envelopes BEGIN
    SELECT RAISE(ABORT, 'managed recovery envelopes are immutable');
END;

CREATE TRIGGER managed_nonces_immutable_update
BEFORE UPDATE ON managed_nonces BEGIN
    SELECT RAISE(ABORT, 'managed nonces are immutable');
END;
CREATE TRIGGER managed_nonces_immutable_delete
BEFORE DELETE ON managed_nonces BEGIN
    SELECT RAISE(ABORT, 'managed nonces are immutable');
END;

CREATE TRIGGER managed_blob_uploads_immutable_update
BEFORE UPDATE ON managed_blob_uploads BEGIN
    SELECT RAISE(ABORT, 'managed blob uploads are immutable');
END;
CREATE TRIGGER managed_blob_uploads_immutable_delete
BEFORE DELETE ON managed_blob_uploads BEGIN
    SELECT RAISE(ABORT, 'managed blob uploads are immutable');
END;

CREATE TRIGGER managed_blob_chunks_immutable_update
BEFORE UPDATE ON managed_blob_chunks BEGIN
    SELECT RAISE(ABORT, 'managed blob chunks are immutable');
END;
CREATE TRIGGER managed_blob_chunks_immutable_delete
BEFORE DELETE ON managed_blob_chunks BEGIN
    SELECT RAISE(ABORT, 'managed blob chunks are immutable');
END;

CREATE TRIGGER managed_committed_blobs_immutable_update
BEFORE UPDATE ON managed_committed_blobs BEGIN
    SELECT RAISE(ABORT, 'managed committed blobs are immutable');
END;
CREATE TRIGGER managed_committed_blobs_immutable_delete
BEFORE DELETE ON managed_committed_blobs BEGIN
    SELECT RAISE(ABORT, 'managed committed blobs are immutable');
END;

CREATE TRIGGER managed_manifests_immutable_update
BEFORE UPDATE ON managed_manifests BEGIN
    SELECT RAISE(ABORT, 'managed manifests are immutable');
END;
CREATE TRIGGER managed_manifests_immutable_delete
BEFORE DELETE ON managed_manifests BEGIN
    SELECT RAISE(ABORT, 'managed manifests are immutable');
END;

CREATE TRIGGER managed_checkpoints_immutable_update
BEFORE UPDATE ON managed_device_checkpoints BEGIN
    SELECT RAISE(ABORT, 'managed checkpoints are immutable');
END;
CREATE TRIGGER managed_checkpoints_immutable_delete
BEFORE DELETE ON managed_device_checkpoints BEGIN
    SELECT RAISE(ABORT, 'managed checkpoints are immutable');
END;

CREATE TRIGGER managed_tombstones_immutable_update
BEFORE UPDATE ON managed_deletion_tombstones BEGIN
    SELECT RAISE(ABORT, 'managed tombstones are immutable');
END;
CREATE TRIGGER managed_tombstones_immutable_delete
BEFORE DELETE ON managed_deletion_tombstones BEGIN
    SELECT RAISE(ABORT, 'managed tombstones are immutable');
END;
