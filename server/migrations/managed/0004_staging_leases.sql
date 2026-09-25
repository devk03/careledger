-- Managed hosted E2EE schema, independent lineage, version 4.
-- CREATE ONLY; never apply to the community/trusted-local database.
-- One durable pre-write lease per one-use intent. Its bytes remain charged
-- after an interrupted upload until a separately reviewed orphan reconciler
-- proves object cleanup. No automatic lease release is defined here.

CREATE TABLE managed_staging_leases (
  household_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL CHECK (
    length(attempt_id) = 32 AND attempt_id NOT GLOB '*[^0-9a-f]*'
  ),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes BETWEEN 65 AND 104860833),
  opened_at INTEGER NOT NULL CHECK (opened_at > 0),
  committed_at INTEGER CHECK (committed_at >= opened_at),
  PRIMARY KEY (household_id, intent_id),
  UNIQUE (household_id, attempt_id),
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_upload_intents(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_staging_lease_guard
BEFORE INSERT ON managed_staging_leases
BEGIN
  SELECT CASE WHEN NEW.committed_at IS NOT NULL
      OR NEW.opened_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_upload_intents i
    JOIN managed_devices d ON d.household_id = i.household_id
      AND d.id = i.writer_device_id
    JOIN managed_grant_heads g ON g.household_id = i.household_id
      AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id
      AND g.subject_device_id = i.writer_device_id
    JOIN managed_sessions s ON s.household_id = i.household_id
      AND s.id = i.session_id AND s.account_id = d.account_id
    JOIN managed_memberships m ON m.household_id = i.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = i.household_id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND i.consumed_at IS NULL AND i.expires_at > unixepoch('now')
      AND NEW.reserved_bytes = 33 + i.plaintext_bytes + 32 * i.chunk_count
      AND d.state = 'active' AND (g.capability_mask & 2) = 2
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'staging lease lacks live authorized intent') END;
END;

CREATE TRIGGER managed_blob_requires_staging_lease
BEFORE INSERT ON managed_committed_blobs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_staging_leases l
    WHERE l.household_id = NEW.household_id AND l.intent_id = NEW.intent_id
      AND l.committed_at IS NULL AND l.reserved_bytes = NEW.wire_bytes
  ) THEN RAISE(ABORT, 'blob has no matching staging lease') END;
END;

CREATE TRIGGER managed_blob_consumes_staging_lease
AFTER INSERT ON managed_committed_blobs
BEGIN
  UPDATE managed_staging_leases SET committed_at = NEW.committed_at
  WHERE household_id = NEW.household_id AND intent_id = NEW.intent_id;
END;

CREATE TRIGGER managed_staging_lease_update_guard
BEFORE UPDATE ON managed_staging_leases
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
      OR NEW.intent_id IS NOT OLD.intent_id
      OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.reserved_bytes IS NOT OLD.reserved_bytes
      OR NEW.opened_at IS NOT OLD.opened_at
      OR OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM managed_committed_blobs b
        WHERE b.household_id = NEW.household_id AND b.intent_id = NEW.intent_id
          AND b.committed_at = NEW.committed_at
      ) THEN RAISE(ABORT, 'staging lease is immutable except commit') END;
END;

CREATE TRIGGER managed_staging_lease_no_delete
BEFORE DELETE ON managed_staging_leases
BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE INDEX managed_staging_leases_by_family
ON managed_staging_leases(household_id, committed_at);
