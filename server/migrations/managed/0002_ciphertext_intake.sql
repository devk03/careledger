-- Managed hosted E2EE schema, independent lineage, version 2.
-- CREATE ONLY; no runner registers this file. Requires 0001_identity_scopes.sql.
-- No clinical dates, filenames, text, or decrypted keys may be stored here.
-- Application must authenticate sessions, verify the exact v2 wire and object
-- bytes/hashes, fsync the private staged object, then publish in one DB transaction.
-- SQL cannot prove submitted bytes are actually encrypted or signatures valid.
-- A committed blob is still an unreferenced encrypted object, not a published
-- care-day revision. Revision compare-and-swap belongs to a later migration;
-- no intake or read route may be mounted from this file alone.

CREATE TABLE managed_upload_intents (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  purpose TEXT NOT NULL CHECK (purpose = 'day'),
  wire_version INTEGER NOT NULL CHECK (wire_version = 2),
  blob_id TEXT NOT NULL CHECK (length(blob_id) = 32 AND blob_id NOT GLOB '*[^0-9a-f]*'),
  writer_device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL CHECK (plaintext_bytes BETWEEN 0 AND 104857600),
  chunk_count INTEGER NOT NULL CHECK (
    chunk_count = max(1, (plaintext_bytes + 1048575) / 1048576)
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 600
  ),
  consumed_at INTEGER CHECK (consumed_at BETWEEN created_at AND expires_at),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, blob_id),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, writer_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_upload_intent_authority
BEFORE INSERT ON managed_upload_intents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_key_identities k
    JOIN managed_scopes s ON s.household_id = k.household_id
      AND s.profile_id = k.profile_id AND s.id = k.scope_id
    WHERE k.household_id = NEW.household_id AND k.key_id = NEW.key_id
      AND k.epoch = NEW.epoch AND k.profile_id = NEW.profile_id
      AND k.scope_id = NEW.scope_id AND k.purpose = NEW.purpose
      AND s.state = 'active'
  ) THEN RAISE(ABORT, 'upload key and scope mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_grant_heads g JOIN managed_devices d
      ON d.household_id = g.household_id AND d.id = g.subject_device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_sessions ss ON ss.household_id = d.household_id
      AND ss.id = NEW.session_id AND ss.account_id = d.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE g.household_id = NEW.household_id AND g.profile_id = NEW.profile_id
      AND g.scope_id = NEW.scope_id AND g.subject_device_id = NEW.writer_device_id
      AND (g.capability_mask & 2) = 2 AND d.state = 'active'
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
      AND ss.revoked_at IS NULL AND ss.expires_at > unixepoch('now')
      AND ss.account_auth_version = a.auth_version
      AND ss.membership_auth_version = m.auth_version
  ) THEN RAISE(ABORT, 'writer lacks current contribution grant') END;
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NEW.expires_at <= unixepoch('now')
    THEN RAISE(ABORT, 'upload intent must be created now') END;
END;

CREATE TABLE managed_nonce_reservations (
  household_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  intent_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  reserved_at INTEGER NOT NULL CHECK (reserved_at > 0),
  PRIMARY KEY (household_id, key_id, epoch, nonce),
  UNIQUE (household_id, intent_id, chunk_index),
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_upload_intents(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_nonce_intent_match
BEFORE INSERT ON managed_nonce_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_upload_intents i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND i.key_id = NEW.key_id AND i.epoch = NEW.epoch
      AND NEW.chunk_index < i.chunk_count AND i.consumed_at IS NULL
      AND i.expires_at > unixepoch('now')
  ) THEN RAISE(ABORT, 'nonce reservation has no live matching intent') END;
  SELECT CASE WHEN NEW.reserved_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5
    THEN RAISE(ABORT, 'nonce reservation must be created now') END;
END;

CREATE TABLE managed_blob_chunks (
  household_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext_bytes INTEGER NOT NULL CHECK (
    ciphertext_bytes BETWEEN 16 AND 1048592
  ),
  ciphertext_sha256 BLOB NOT NULL CHECK (length(ciphertext_sha256) = 32),
  PRIMARY KEY (household_id, intent_id, chunk_index),
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_upload_intents(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_chunk_matches_reservation
BEFORE INSERT ON managed_blob_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_nonce_reservations n JOIN managed_upload_intents i
      ON i.household_id = n.household_id AND i.id = n.intent_id
    WHERE n.household_id = NEW.household_id AND n.intent_id = NEW.intent_id
      AND n.chunk_index = NEW.chunk_index AND n.nonce = NEW.nonce
      AND i.consumed_at IS NULL AND i.expires_at > unixepoch('now')
      AND NEW.ciphertext_bytes = 16 + max(0, min(1048576,
        i.plaintext_bytes - NEW.chunk_index * 1048576))
  ) THEN RAISE(ABORT, 'chunk does not match nonce or expected size') END;
END;

CREATE TABLE managed_committed_blobs (
  household_id TEXT NOT NULL,
  blob_id TEXT NOT NULL CHECK (length(blob_id) = 32 AND blob_id NOT GLOB '*[^0-9a-f]*'),
  intent_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  writer_device_id TEXT NOT NULL,
  wire_version INTEGER NOT NULL CHECK (wire_version = 2),
  wire_sha256 BLOB NOT NULL CHECK (length(wire_sha256) = 32),
  wire_bytes INTEGER NOT NULL CHECK (wire_bytes BETWEEN 65 AND 104860833),
  committed_at INTEGER NOT NULL CHECK (committed_at > 0),
  PRIMARY KEY (household_id, blob_id),
  UNIQUE (household_id, intent_id),
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_upload_intents(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, writer_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_blob_commit_guard
BEFORE INSERT ON managed_committed_blobs
BEGIN
  SELECT CASE WHEN NEW.committed_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5
    THEN RAISE(ABORT, 'blob commit must occur now') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_upload_intents i
    JOIN managed_grant_heads g ON g.household_id = i.household_id
      AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id
      AND g.subject_device_id = i.writer_device_id
    JOIN managed_devices d ON d.household_id = i.household_id
      AND d.id = i.writer_device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_sessions ss ON ss.household_id = i.household_id
      AND ss.id = i.session_id AND ss.account_id = d.account_id
    JOIN managed_families f ON f.id = m.household_id
    JOIN managed_scopes s ON s.household_id = i.household_id
      AND s.profile_id = i.profile_id AND s.id = i.scope_id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND i.blob_id = NEW.blob_id AND i.profile_id = NEW.profile_id
      AND i.scope_id = NEW.scope_id AND i.key_id = NEW.key_id
      AND i.epoch = NEW.epoch AND i.writer_device_id = NEW.writer_device_id
      AND i.wire_version = NEW.wire_version AND i.consumed_at IS NULL
      AND i.expires_at > unixepoch('now') AND (g.capability_mask & 2) = 2
      AND d.state = 'active' AND m.state = 'active' AND a.state = 'active'
      AND f.state = 'active' AND s.state = 'active'
      AND ss.revoked_at IS NULL AND ss.expires_at > unixepoch('now')
      AND ss.account_auth_version = a.auth_version
      AND ss.membership_auth_version = m.auth_version
      AND NEW.wire_bytes = 33 + 16 * i.chunk_count + i.plaintext_bytes
        + 16 * i.chunk_count
      AND i.chunk_count = (
        SELECT COUNT(*) FROM managed_blob_chunks c
        WHERE c.household_id = i.household_id AND c.intent_id = i.id
      )
      AND i.chunk_count = (
        SELECT COUNT(*) FROM managed_nonce_reservations n
        WHERE n.household_id = i.household_id AND n.intent_id = i.id
      )
  ) THEN RAISE(ABORT, 'blob commit lacks complete authorized intent') END;
END;

CREATE TRIGGER managed_blob_consume_intent
AFTER INSERT ON managed_committed_blobs
BEGIN
  UPDATE managed_upload_intents SET consumed_at = NEW.committed_at
  WHERE household_id = NEW.household_id AND id = NEW.intent_id;
END;

CREATE TRIGGER managed_intent_update_guard
BEFORE UPDATE ON managed_upload_intents
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id
    OR NEW.profile_id IS NOT OLD.profile_id OR NEW.scope_id IS NOT OLD.scope_id
    OR NEW.key_id IS NOT OLD.key_id OR NEW.epoch IS NOT OLD.epoch
    OR NEW.purpose IS NOT OLD.purpose OR NEW.wire_version IS NOT OLD.wire_version
    OR NEW.blob_id IS NOT OLD.blob_id
    OR NEW.writer_device_id IS NOT OLD.writer_device_id
    OR NEW.session_id IS NOT OLD.session_id
    OR NEW.plaintext_bytes IS NOT OLD.plaintext_bytes
    OR NEW.chunk_count IS NOT OLD.chunk_count
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
    OR NOT EXISTS (SELECT 1 FROM managed_committed_blobs b
      WHERE b.household_id = NEW.household_id AND b.intent_id = NEW.id
        AND b.committed_at = NEW.consumed_at)
    THEN RAISE(ABORT, 'intent is immutable except commit consumption') END;
END;

CREATE TRIGGER managed_intent_no_delete
BEFORE DELETE ON managed_upload_intents BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_nonce_no_update
BEFORE UPDATE ON managed_nonce_reservations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_nonce_no_delete
BEFORE DELETE ON managed_nonce_reservations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_chunk_no_update
BEFORE UPDATE ON managed_blob_chunks BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_chunk_no_delete
BEFORE DELETE ON managed_blob_chunks BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_blob_no_update
BEFORE UPDATE ON managed_committed_blobs BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_blob_no_delete
BEFORE DELETE ON managed_committed_blobs BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE INDEX managed_intents_by_expiry
ON managed_upload_intents(expires_at, consumed_at);
CREATE INDEX managed_blobs_by_scope
ON managed_committed_blobs(household_id, profile_id, scope_id, committed_at);
CREATE UNIQUE INDEX managed_recovery_nonce_unique
ON managed_owner_recovery(household_id, root_commitment, nonce);
