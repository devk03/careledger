-- Managed hosted E2EE schema, independent lineage, version 6.
-- CREATE ONLY. Never apply to a community/trusted-local or real-family DB.
-- No active key is inferred from MAX(epoch), timestamps, or existing material.
-- Every scope starts with an empty head and fails closed until its owner signs
-- an activation. Existing v5 data would require a separately reviewed,
-- device-verified bootstrap; this migration does not fabricate one.
-- Application must verify the exact canonical, domain-separated Ed25519
-- activation payload. It must bind household/profile/scope/purpose, old head,
-- new key ID/epoch/commitment/registration digest, issuer/session/counter/time.

CREATE UNIQUE INDEX managed_key_commitment_unique
ON managed_key_identities(household_id, key_commitment);

CREATE TABLE managed_active_key_heads (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  head_sha256 BLOB CHECK (length(head_sha256) = 32),
  key_id TEXT,
  epoch INTEGER CHECK (epoch BETWEEN 1 AND 4294967295),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (household_id, profile_id, scope_id),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  CHECK ((sequence = 0 AND head_sha256 IS NULL AND key_id IS NULL AND epoch IS NULL)
    OR (sequence > 0 AND head_sha256 IS NOT NULL
      AND key_id IS NOT NULL AND epoch IS NOT NULL))
) STRICT;

CREATE TABLE managed_active_key_events (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_sha256 BLOB CHECK (length(previous_sha256) = 32),
  previous_key_id TEXT,
  previous_epoch INTEGER CHECK (previous_epoch BETWEEN 1 AND 4294967295),
  event_sha256 BLOB NOT NULL CHECK (length(event_sha256) = 32),
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  purpose TEXT NOT NULL CHECK (purpose IN ('day', 'source', 'draft', 'index')),
  key_commitment BLOB NOT NULL CHECK (length(key_commitment) = 32),
  registration_sha256 BLOB NOT NULL CHECK (length(registration_sha256) = 32),
  issuer_device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  issuer_counter INTEGER NOT NULL CHECK (issuer_counter > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, profile_id, scope_id, sequence),
  UNIQUE (household_id, issuer_device_id, issuer_counter),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_active_key_heads(household_id, profile_id, scope_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, previous_key_id, previous_epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, issuer_device_id, issuer_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter)
    ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT,
  CHECK ((sequence = 1 AND previous_sha256 IS NULL
      AND previous_key_id IS NULL AND previous_epoch IS NULL)
    OR (sequence > 1 AND previous_sha256 IS NOT NULL
      AND previous_key_id IS NOT NULL AND previous_epoch IS NOT NULL))
) STRICT;

CREATE TRIGGER managed_active_key_head_initial
BEFORE INSERT ON managed_active_key_heads
BEGIN
  SELECT CASE WHEN NEW.sequence != 0 OR NEW.head_sha256 IS NOT NULL
      OR NEW.key_id IS NOT NULL OR NEW.epoch IS NOT NULL
      OR NEW.updated_at NOT BETWEEN unixepoch('now') - 5
        AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_scopes sc
    JOIN managed_profiles p ON p.household_id = sc.household_id
      AND p.id = sc.profile_id
    JOIN managed_families f ON f.id = sc.household_id
    WHERE sc.household_id = NEW.household_id AND sc.profile_id = NEW.profile_id
      AND sc.id = NEW.scope_id AND sc.state = 'active'
      AND p.state = 'active' AND f.state IN ('active', 'frozen')
  ) THEN RAISE(ABORT, 'active key head must start empty on live scope') END;
END;

-- Existing active scopes are quarantined at sequence zero. The owner must
-- verify history and sign an activation; no key is inferred from old rows.
INSERT INTO managed_active_key_heads
  (household_id, profile_id, scope_id, sequence, head_sha256, key_id, epoch, updated_at)
SELECT sc.household_id, sc.profile_id, sc.id, 0, NULL, NULL, NULL, unixepoch('now')
FROM managed_scopes sc
JOIN managed_profiles p ON p.household_id = sc.household_id AND p.id = sc.profile_id
JOIN managed_families f ON f.id = sc.household_id
WHERE sc.state = 'active' AND p.state = 'active';

CREATE TRIGGER managed_scope_creates_empty_key_head
AFTER INSERT ON managed_scopes
WHEN NEW.state = 'active'
BEGIN
  INSERT INTO managed_active_key_heads
    (household_id, profile_id, scope_id, sequence, head_sha256, key_id, epoch, updated_at)
  VALUES (NEW.household_id, NEW.profile_id, NEW.id, 0, NULL, NULL, NULL,
    unixepoch('now'));
END;

CREATE TRIGGER managed_active_key_head_event_only
BEFORE UPDATE ON managed_active_key_heads
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
      OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.scope_id IS NOT OLD.scope_id
      OR NEW.sequence != OLD.sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM managed_active_key_events e
    WHERE e.household_id = NEW.household_id
      AND e.profile_id = NEW.profile_id AND e.scope_id = NEW.scope_id
      AND e.sequence = NEW.sequence AND e.event_sha256 = NEW.head_sha256
      AND e.key_id = NEW.key_id AND e.epoch = NEW.epoch
      AND e.created_at = NEW.updated_at
  ) THEN RAISE(ABORT, 'active key head requires matching event') END;
END;

CREATE TRIGGER managed_active_key_event_cas
BEFORE INSERT ON managed_active_key_events
BEGIN
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_active_key_heads h
    JOIN managed_scopes sc ON sc.household_id = h.household_id
      AND sc.profile_id = h.profile_id AND sc.id = h.scope_id
    JOIN managed_profiles p ON p.household_id = h.household_id
      AND p.id = h.profile_id
    JOIN managed_key_identities k ON k.household_id = h.household_id
      AND k.key_id = NEW.key_id AND k.epoch = NEW.epoch
    JOIN managed_signed_actions action ON action.household_id = h.household_id
      AND action.device_id = NEW.issuer_device_id
      AND action.counter = NEW.issuer_counter
    JOIN managed_devices d ON d.household_id = h.household_id
      AND d.id = NEW.issuer_device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = h.household_id
    JOIN managed_sessions s ON s.household_id = h.household_id
      AND s.id = NEW.session_id AND s.account_id = d.account_id
    WHERE h.household_id = NEW.household_id
      AND h.profile_id = NEW.profile_id AND h.scope_id = NEW.scope_id
      AND NEW.sequence = h.sequence + 1
      AND NEW.previous_sha256 IS h.head_sha256
      AND NEW.previous_key_id IS h.key_id
      AND NEW.previous_epoch IS h.epoch
      AND NEW.epoch = coalesce(h.epoch, 0) + 1
      AND k.profile_id = h.profile_id AND k.scope_id = h.scope_id
      AND k.purpose = sc.kind AND NEW.purpose = sc.kind
      AND NEW.key_commitment = k.key_commitment
      AND NEW.registration_sha256 = k.signed_payload_sha256
      AND sc.state = 'active' AND p.state = 'active'
      AND action.action_kind = 'key'
      AND action.payload_sha256 = NEW.event_sha256
      AND action.created_at <= NEW.created_at
      AND NOT EXISTS (SELECT 1 FROM managed_key_identities registration
        WHERE registration.household_id = NEW.household_id
          AND registration.issuer_device_id = NEW.issuer_device_id
          AND registration.issuer_counter = NEW.issuer_counter)
      AND d.state = 'active' AND m.role = 'owner' AND m.state = 'active'
      AND a.state = 'active' AND f.state = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
  ) THEN RAISE(ABORT, 'active key event is stale or unauthorized') END;
END;

CREATE TRIGGER managed_active_key_event_advance
AFTER INSERT ON managed_active_key_events
BEGIN
  UPDATE managed_active_key_heads SET sequence = NEW.sequence,
    head_sha256 = NEW.event_sha256, key_id = NEW.key_id, epoch = NEW.epoch,
    updated_at = NEW.created_at
  WHERE household_id = NEW.household_id AND profile_id = NEW.profile_id
    AND scope_id = NEW.scope_id;
END;

CREATE TRIGGER managed_key_registration_counter_not_activation
BEFORE INSERT ON managed_key_identities
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM managed_active_key_events e
    WHERE e.household_id = NEW.household_id
      AND e.issuer_device_id = NEW.issuer_device_id
      AND e.issuer_counter = NEW.issuer_counter
  ) THEN RAISE(ABORT, 'key action already used for activation') END;
END;

CREATE TRIGGER managed_active_key_head_no_delete
BEFORE DELETE ON managed_active_key_heads BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_active_key_event_no_update
BEFORE UPDATE ON managed_active_key_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_active_key_event_no_delete
BEFORE DELETE ON managed_active_key_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE VIEW managed_current_scope_keys AS
SELECT h.household_id, h.profile_id, h.scope_id, h.key_id, h.epoch,
  h.sequence, h.head_sha256
FROM managed_active_key_heads h
JOIN managed_scopes sc ON sc.household_id = h.household_id
  AND sc.profile_id = h.profile_id AND sc.id = h.scope_id
JOIN managed_profiles p ON p.household_id = h.household_id
  AND p.id = h.profile_id
JOIN managed_families f ON f.id = h.household_id
WHERE h.sequence > 0 AND sc.state = 'active'
  AND p.state = 'active' AND f.state = 'active';

CREATE VIEW managed_day_intents_on_current_key AS
SELECT i.household_id, i.id
FROM managed_upload_intents i
JOIN managed_current_scope_keys h ON h.household_id = i.household_id
  AND h.profile_id = i.profile_id AND h.scope_id = i.scope_id
  AND h.key_id = i.key_id AND h.epoch = i.epoch;

CREATE VIEW managed_non_day_intents_on_current_key AS
SELECT i.household_id, i.id
FROM managed_non_day_upload_intents i
JOIN managed_current_scope_keys h ON h.household_id = i.household_id
  AND h.profile_id = i.profile_id AND h.scope_id = i.scope_id
  AND h.key_id = i.key_id AND h.epoch = i.epoch;

-- Rotation invalidates every uncommitted intent and lease using the old key.
-- Historical ciphertext remains immutable and potentially readable under a
-- separately authorized old-key envelope; it may not be newly published.
CREATE TRIGGER managed_day_intent_current_key
BEFORE INSERT ON managed_upload_intents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_current_scope_keys h
    WHERE h.household_id = NEW.household_id
      AND h.profile_id = NEW.profile_id AND h.scope_id = NEW.scope_id
      AND h.key_id = NEW.key_id AND h.epoch = NEW.epoch
  ) THEN RAISE(ABORT, 'day intent key is not active') END;
END;

CREATE TRIGGER managed_day_lease_current_key
BEFORE INSERT ON managed_staging_leases
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_day_intents_on_current_key i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'day staging key is not active') END;
END;

CREATE TRIGGER managed_day_nonce_current_key
BEFORE INSERT ON managed_nonce_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_day_intents_on_current_key i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'day nonce key is not active') END;
END;

CREATE TRIGGER managed_day_chunk_current_key
BEFORE INSERT ON managed_blob_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_day_intents_on_current_key i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'day chunk key is not active') END;
END;

CREATE TRIGGER managed_day_blob_current_key
BEFORE INSERT ON managed_committed_blobs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_day_intents_on_current_key i
    JOIN managed_upload_intents intent
      ON intent.household_id = i.household_id AND intent.id = i.id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND intent.blob_id = NEW.blob_id
      AND intent.key_id = NEW.key_id AND intent.epoch = NEW.epoch
  ) THEN RAISE(ABORT, 'day blob key is not active') END;
END;

CREATE TRIGGER managed_day_revision_current_key
BEFORE INSERT ON managed_day_revisions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_committed_blobs b
    JOIN managed_current_scope_keys h ON h.household_id = b.household_id
      AND h.profile_id = b.profile_id AND h.scope_id = b.scope_id
      AND h.key_id = b.key_id AND h.epoch = b.epoch
    WHERE b.household_id = NEW.household_id AND b.blob_id = NEW.blob_id
      AND b.profile_id = NEW.profile_id AND b.scope_id = NEW.scope_id
  ) THEN RAISE(ABORT, 'day revision blob key is not active') END;
END;

CREATE TRIGGER managed_draft_reservation_current_key
BEFORE INSERT ON managed_draft_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_current_scope_keys h
    WHERE h.household_id = NEW.household_id
      AND h.profile_id = NEW.profile_id AND h.scope_id = NEW.scope_id
      AND h.key_id = NEW.key_id AND h.epoch = NEW.epoch
  ) THEN RAISE(ABORT, 'draft reservation key is not active') END;
END;

CREATE TRIGGER managed_non_day_intent_current_key
BEFORE INSERT ON managed_non_day_upload_intents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_current_scope_keys h
    WHERE h.household_id = NEW.household_id
      AND h.profile_id = NEW.profile_id AND h.scope_id = NEW.scope_id
      AND h.key_id = NEW.key_id AND h.epoch = NEW.epoch
  ) THEN RAISE(ABORT, 'non-day intent key is not active') END;
END;

CREATE TRIGGER managed_non_day_lease_current_key
BEFORE INSERT ON managed_non_day_staging_leases
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_non_day_intents_on_current_key i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'non-day staging key is not active') END;
END;

CREATE TRIGGER managed_non_day_nonce_current_key
BEFORE INSERT ON managed_non_day_nonce_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_non_day_intents_on_current_key i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'non-day nonce key is not active') END;
END;

CREATE TRIGGER managed_non_day_chunk_current_key
BEFORE INSERT ON managed_non_day_blob_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_non_day_intents_on_current_key i
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'non-day chunk key is not active') END;
END;

CREATE TRIGGER managed_non_day_blob_current_key
BEFORE INSERT ON managed_non_day_committed_blobs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_non_day_intents_on_current_key i
    JOIN managed_non_day_upload_intents intent
      ON intent.household_id = i.household_id AND intent.id = i.id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND intent.blob_id = NEW.blob_id
      AND intent.key_id = NEW.key_id AND intent.epoch = NEW.epoch
  ) THEN RAISE(ABORT, 'non-day blob key is not active') END;
END;

CREATE TRIGGER managed_pending_draft_pair_current_key
BEFORE INSERT ON managed_pending_draft_pairs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_current_scope_keys h
    JOIN managed_non_day_committed_blobs content
      ON content.household_id = h.household_id
      AND content.profile_id = h.profile_id AND content.scope_id = h.scope_id
      AND content.key_id = h.key_id AND content.epoch = h.epoch
    JOIN managed_non_day_committed_blobs metadata
      ON metadata.household_id = h.household_id
      AND metadata.profile_id = h.profile_id AND metadata.scope_id = h.scope_id
      AND metadata.key_id = h.key_id AND metadata.epoch = h.epoch
    WHERE h.household_id = NEW.household_id
      AND h.profile_id = NEW.profile_id AND h.scope_id = NEW.scope_id
      AND h.key_id = NEW.key_id AND h.epoch = NEW.epoch
      AND content.blob_id = NEW.content_blob_id
      AND metadata.blob_id = NEW.metadata_blob_id
  ) THEN RAISE(ABORT, 'pending draft pair key is not active') END;
END;
