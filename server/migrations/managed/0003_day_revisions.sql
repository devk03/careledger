-- Managed hosted E2EE schema, independent lineage, version 3.
-- CREATE ONLY; no runner registers this file. Requires 0001 and 0002.
-- This is an append-only opaque day-snapshot chain. It does not establish
-- freshness on a new device, decrypt content, or enable the managed runtime.
-- The application verifies exact signed canonical revision payloads and object
-- hashes before entering the transaction. SQL enforces sequence and authority.

CREATE TABLE managed_day_revision_heads (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  head_sha256 BLOB CHECK (length(head_sha256) = 32),
  current_blob_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (household_id, profile_id, scope_id),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, current_blob_id)
    REFERENCES managed_committed_blobs(household_id, blob_id) ON DELETE RESTRICT,
  CHECK ((sequence = 0) = (head_sha256 IS NULL)),
  CHECK ((sequence = 0) = (current_blob_id IS NULL))
) STRICT;

CREATE TABLE managed_day_revisions (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_sha256 BLOB CHECK (length(previous_sha256) = 32),
  revision_sha256 BLOB NOT NULL CHECK (length(revision_sha256) = 32),
  blob_id TEXT NOT NULL,
  author_device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  author_counter INTEGER NOT NULL CHECK (author_counter > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, profile_id, scope_id, sequence),
  UNIQUE (household_id, blob_id),
  UNIQUE (household_id, author_device_id, author_counter),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_day_revision_heads(household_id, profile_id, scope_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (household_id, blob_id)
    REFERENCES managed_committed_blobs(household_id, blob_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, author_device_id, author_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter)
    ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT,
  CHECK ((sequence = 1) = (previous_sha256 IS NULL))
) STRICT;

CREATE TRIGGER managed_day_head_initial
BEFORE INSERT ON managed_day_revision_heads
BEGIN
  SELECT CASE WHEN NEW.sequence != 0 OR NEW.head_sha256 IS NOT NULL
    OR NEW.current_blob_id IS NOT NULL
    THEN RAISE(ABORT, 'day revision head must start empty') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_scopes s JOIN managed_families f
      ON f.id = s.household_id
    WHERE s.household_id = NEW.household_id AND s.profile_id = NEW.profile_id
      AND s.id = NEW.scope_id AND s.kind = 'day' AND s.state = 'active'
      AND f.state = 'active'
  ) THEN RAISE(ABORT, 'day revision head requires active day scope') END;
END;

CREATE TRIGGER managed_day_head_event_only
BEFORE UPDATE ON managed_day_revision_heads
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
    OR NEW.profile_id IS NOT OLD.profile_id OR NEW.scope_id IS NOT OLD.scope_id
    THEN RAISE(ABORT, 'day head identity is immutable') END;
  SELECT CASE WHEN NEW.sequence != OLD.sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM managed_day_revisions r
    WHERE r.household_id = NEW.household_id AND r.profile_id = NEW.profile_id
      AND r.scope_id = NEW.scope_id AND r.sequence = NEW.sequence
      AND r.revision_sha256 = NEW.head_sha256
      AND r.blob_id = NEW.current_blob_id AND r.created_at = NEW.updated_at
  ) THEN RAISE(ABORT, 'day head requires matching revision') END;
END;

CREATE TRIGGER managed_day_revision_cas
BEFORE INSERT ON managed_day_revisions
BEGIN
  SELECT CASE WHEN NEW.sequence != 1 + (
    SELECT h.sequence FROM managed_day_revision_heads h
    WHERE h.household_id = NEW.household_id AND h.profile_id = NEW.profile_id
      AND h.scope_id = NEW.scope_id
  ) THEN RAISE(ABORT, 'stale day revision sequence') END;
  SELECT CASE WHEN NEW.previous_sha256 IS NOT (
    SELECT h.head_sha256 FROM managed_day_revision_heads h
    WHERE h.household_id = NEW.household_id AND h.profile_id = NEW.profile_id
      AND h.scope_id = NEW.scope_id
  ) THEN RAISE(ABORT, 'stale day revision predecessor') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_committed_blobs b JOIN managed_upload_intents i
      ON i.household_id = b.household_id AND i.id = b.intent_id
    JOIN managed_scopes s ON s.household_id = b.household_id
      AND s.profile_id = b.profile_id AND s.id = b.scope_id
    WHERE b.household_id = NEW.household_id AND b.blob_id = NEW.blob_id
      AND b.profile_id = NEW.profile_id AND b.scope_id = NEW.scope_id
      AND i.purpose = 'day' AND s.kind = 'day' AND s.state = 'active'
  ) THEN RAISE(ABORT, 'revision blob is not in active day scope') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_signed_actions a JOIN managed_devices d
      ON d.household_id = a.household_id AND d.id = a.device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    JOIN managed_sessions ss ON ss.household_id = a.household_id
      AND ss.id = NEW.session_id AND ss.account_id = d.account_id
    JOIN managed_grant_heads g ON g.household_id = a.household_id
      AND g.profile_id = NEW.profile_id AND g.scope_id = NEW.scope_id
      AND g.subject_device_id = a.device_id
    WHERE a.household_id = NEW.household_id AND a.device_id = NEW.author_device_id
      AND a.counter = NEW.author_counter AND a.action_kind = 'revision'
      AND a.payload_sha256 = NEW.revision_sha256
      AND d.state = 'active' AND m.state = 'active' AND u.state = 'active'
      AND f.state = 'active' AND m.role IN ('owner', 'adult')
      AND (g.capability_mask & 4) = 4
      AND ss.revoked_at IS NULL AND ss.expires_at > unixepoch('now')
      AND ss.account_auth_version = u.auth_version
      AND ss.membership_auth_version = m.auth_version
  ) THEN RAISE(ABORT, 'revision needs active adult publish grant') END;
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
    AND unixepoch('now') + 5
    THEN RAISE(ABORT, 'revision must be created now') END;
END;

CREATE TRIGGER managed_day_revision_advance
AFTER INSERT ON managed_day_revisions
BEGIN
  UPDATE managed_day_revision_heads SET sequence = NEW.sequence,
    head_sha256 = NEW.revision_sha256, current_blob_id = NEW.blob_id,
    updated_at = NEW.created_at
  WHERE household_id = NEW.household_id AND profile_id = NEW.profile_id
    AND scope_id = NEW.scope_id;
END;

CREATE TRIGGER managed_day_head_no_delete
BEFORE DELETE ON managed_day_revision_heads BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_day_revision_no_update
BEFORE UPDATE ON managed_day_revisions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_day_revision_no_delete
BEFORE DELETE ON managed_day_revisions BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE INDEX managed_day_revisions_reverse
ON managed_day_revisions(household_id, profile_id, scope_id, sequence DESC);
