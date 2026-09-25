-- Managed hosted E2EE schema, independent lineage, version 5.
-- CREATE ONLY. Never apply to the community/trusted-local database.
-- Separate source/draft ciphertext from day snapshots. No plaintext, filenames,
-- clinical dates, decrypted keys, or patient labels belong in these tables.
-- This draft does not enable a route, issue keys, verify signatures, or provide
-- source/draft key envelopes. The application must verify exact v2 wire/object
-- bytes and signatures before any publication transaction.

-- Cross-path claims prevent a future source/draft path from colliding with
-- existing day intent, blob, nonce, or private object identities. An underlying
-- AES key reused under a different claimed key_id is not detectable by SQL.
CREATE TABLE managed_upload_id_claims (
  household_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('intent', 'blob')),
  opaque_id TEXT NOT NULL CHECK (
    length(opaque_id) = 32 AND opaque_id NOT GLOB '*[^0-9a-f]*'
  ),
  lineage TEXT NOT NULL CHECK (lineage IN ('day', 'non_day', 'draft_reserved')),
  reservation_id TEXT,
  CHECK ((lineage = 'draft_reserved') = (reservation_id IS NOT NULL)),
  PRIMARY KEY (household_id, kind, opaque_id)
) STRICT;

INSERT INTO managed_upload_id_claims
  (household_id, kind, opaque_id, lineage, reservation_id)
SELECT household_id, 'intent', id, 'day', NULL FROM managed_upload_intents;
INSERT INTO managed_upload_id_claims
  (household_id, kind, opaque_id, lineage, reservation_id)
SELECT household_id, 'blob', blob_id, 'day', NULL FROM managed_upload_intents;

CREATE TRIGGER managed_day_upload_id_claim
AFTER INSERT ON managed_upload_intents
BEGIN
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'intent', NEW.id, 'day', NULL);
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'blob', NEW.blob_id, 'day', NULL);
END;

CREATE TABLE managed_ciphertext_nonce_claims (
  household_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  lineage TEXT NOT NULL CHECK (lineage IN ('day', 'non_day')),
  intent_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  reserved_at INTEGER NOT NULL CHECK (reserved_at > 0),
  PRIMARY KEY (household_id, key_id, epoch, nonce),
  UNIQUE (household_id, lineage, intent_id, chunk_index),
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT
) STRICT;

INSERT INTO managed_ciphertext_nonce_claims
  (household_id, key_id, epoch, nonce, lineage, intent_id, chunk_index, reserved_at)
SELECT household_id, key_id, epoch, nonce, 'day', intent_id, chunk_index, reserved_at
FROM managed_nonce_reservations;

CREATE TRIGGER managed_day_nonce_global_claim
AFTER INSERT ON managed_nonce_reservations
BEGIN
  INSERT INTO managed_ciphertext_nonce_claims VALUES
    (NEW.household_id, NEW.key_id, NEW.epoch, NEW.nonce, 'day',
      NEW.intent_id, NEW.chunk_index, NEW.reserved_at);
END;

CREATE TABLE managed_storage_object_claims (
  household_id TEXT NOT NULL,
  storage_object_id TEXT NOT NULL CHECK (
    length(storage_object_id) = 32 AND storage_object_id NOT GLOB '*[^0-9a-f]*'
  ),
  lineage TEXT NOT NULL CHECK (lineage IN ('day', 'non_day')),
  intent_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  PRIMARY KEY (household_id, storage_object_id),
  UNIQUE (household_id, lineage, intent_id, chunk_index)
) STRICT;

INSERT INTO managed_storage_object_claims
  (household_id, storage_object_id, lineage, intent_id, chunk_index)
SELECT household_id, storage_object_id, 'day', intent_id, chunk_index
FROM managed_blob_chunks;

CREATE TRIGGER managed_day_object_global_claim
AFTER INSERT ON managed_blob_chunks
BEGIN
  INSERT INTO managed_storage_object_claims VALUES
    (NEW.household_id, NEW.storage_object_id, 'day', NEW.intent_id, NEW.chunk_index);
END;

CREATE TRIGGER managed_upload_id_claims_no_update
BEFORE UPDATE ON managed_upload_id_claims BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_upload_id_claims_no_delete
BEFORE DELETE ON managed_upload_id_claims BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_ciphertext_nonce_claims_no_update
BEFORE UPDATE ON managed_ciphertext_nonce_claims BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_ciphertext_nonce_claims_no_delete
BEFORE DELETE ON managed_ciphertext_nonce_claims BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_storage_object_claims_no_update
BEFORE UPDATE ON managed_storage_object_claims BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_storage_object_claims_no_delete
BEFORE DELETE ON managed_storage_object_claims BEGIN SELECT RAISE(ABORT, 'immutable'); END;

-- The server issues one reservation containing both draft blob/intent IDs
-- before the device encrypts content or metadata. The two identities and
-- their common key/scope cannot be changed afterward.
CREATE TABLE managed_draft_reservations (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  writer_device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  content_intent_id TEXT NOT NULL CHECK (
    length(content_intent_id) = 32 AND content_intent_id NOT GLOB '*[^0-9a-f]*'
  ),
  metadata_intent_id TEXT NOT NULL CHECK (
    length(metadata_intent_id) = 32 AND metadata_intent_id NOT GLOB '*[^0-9a-f]*'
  ),
  content_blob_id TEXT NOT NULL CHECK (
    length(content_blob_id) = 32 AND content_blob_id NOT GLOB '*[^0-9a-f]*'
  ),
  metadata_blob_id TEXT NOT NULL CHECK (
    length(metadata_blob_id) = 32 AND metadata_blob_id NOT GLOB '*[^0-9a-f]*'
  ),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 600
  ),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, content_intent_id),
  UNIQUE (household_id, metadata_intent_id),
  UNIQUE (household_id, content_blob_id),
  UNIQUE (household_id, metadata_blob_id),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, writer_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT,
  CHECK (content_intent_id != metadata_intent_id),
  CHECK (content_blob_id != metadata_blob_id)
) STRICT;

CREATE TRIGGER managed_draft_reservation_authority
BEFORE INSERT ON managed_draft_reservations
BEGIN
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NEW.expires_at <= unixepoch('now')
    THEN RAISE(ABORT, 'draft reservation must be created now') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_scopes sc
    JOIN managed_profiles p ON p.household_id = sc.household_id
      AND p.id = sc.profile_id
    JOIN managed_key_identities k ON k.household_id = sc.household_id
      AND k.profile_id = sc.profile_id AND k.scope_id = sc.id
    JOIN managed_devices d ON d.household_id = sc.household_id
      AND d.id = NEW.writer_device_id
    JOIN managed_grant_heads g ON g.household_id = sc.household_id
      AND g.profile_id = sc.profile_id AND g.scope_id = sc.id
      AND g.subject_device_id = d.id
    JOIN managed_sessions s ON s.household_id = d.household_id
      AND s.id = NEW.session_id AND s.account_id = d.account_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = sc.household_id
    WHERE sc.household_id = NEW.household_id AND sc.profile_id = NEW.profile_id
      AND sc.id = NEW.scope_id AND sc.kind = 'draft' AND sc.state = 'active'
      AND p.state = 'active' AND k.key_id = NEW.key_id AND k.epoch = NEW.epoch
      AND k.purpose = 'draft' AND d.state = 'active'
      AND (g.capability_mask & 2) = 2 AND s.revoked_at IS NULL
      AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'draft reservation lacks current authority') END;
END;

CREATE TRIGGER managed_draft_reservation_claim_ids
AFTER INSERT ON managed_draft_reservations
BEGIN
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'intent', NEW.content_intent_id, 'draft_reserved', NEW.id);
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'intent', NEW.metadata_intent_id, 'draft_reserved', NEW.id);
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'blob', NEW.content_blob_id, 'draft_reserved', NEW.id);
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'blob', NEW.metadata_blob_id, 'draft_reserved', NEW.id);
END;

CREATE TRIGGER managed_draft_reservations_no_update
BEFORE UPDATE ON managed_draft_reservations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_draft_reservations_no_delete
BEFORE DELETE ON managed_draft_reservations BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TABLE managed_non_day_upload_intents (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  purpose TEXT NOT NULL CHECK (purpose IN ('draft', 'source')),
  role TEXT NOT NULL CHECK (role IN ('content', 'metadata', 'original')),
  draft_reservation_id TEXT,
  object_id TEXT NOT NULL CHECK (
    length(object_id) = 32 AND object_id NOT GLOB '*[^0-9a-f]*'
  ),
  aad_revision INTEGER NOT NULL CHECK (aad_revision BETWEEN 1 AND 4294967295),
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
  UNIQUE (household_id, profile_id, scope_id, object_id),
  UNIQUE (household_id, draft_reservation_id, role),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, writer_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, draft_reservation_id)
    REFERENCES managed_draft_reservations(household_id, id) ON DELETE RESTRICT,
  CHECK ((purpose = 'draft' AND role IN ('content', 'metadata')
      AND draft_reservation_id IS NOT NULL)
    OR (purpose = 'source' AND role = 'original'
      AND draft_reservation_id IS NULL))
) STRICT;

CREATE TRIGGER managed_non_day_intent_authority
BEFORE INSERT ON managed_non_day_upload_intents
BEGIN
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NEW.expires_at <= unixepoch('now')
    THEN RAISE(ABORT, 'non-day intent must be created now') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_scopes sc
    JOIN managed_profiles p ON p.household_id = sc.household_id
      AND p.id = sc.profile_id
    JOIN managed_key_identities k ON k.household_id = sc.household_id
      AND k.profile_id = sc.profile_id AND k.scope_id = sc.id
    JOIN managed_devices d ON d.household_id = sc.household_id
      AND d.id = NEW.writer_device_id
    JOIN managed_grant_heads g ON g.household_id = sc.household_id
      AND g.profile_id = sc.profile_id AND g.scope_id = sc.id
      AND g.subject_device_id = d.id
    JOIN managed_sessions s ON s.household_id = d.household_id
      AND s.id = NEW.session_id AND s.account_id = d.account_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = sc.household_id
    WHERE sc.household_id = NEW.household_id AND sc.profile_id = NEW.profile_id
      AND sc.id = NEW.scope_id AND sc.kind = NEW.purpose
      AND sc.state = 'active' AND p.state = 'active'
      AND k.key_id = NEW.key_id AND k.epoch = NEW.epoch
      AND k.purpose = NEW.purpose AND d.state = 'active'
      AND (g.capability_mask & 2) = 2 AND s.revoked_at IS NULL
      AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'non-day intent lacks current authority') END;
  SELECT CASE WHEN NEW.purpose = 'draft' AND NOT EXISTS (
    SELECT 1 FROM managed_draft_reservations r
    WHERE r.household_id = NEW.household_id AND r.id = NEW.draft_reservation_id
      AND r.profile_id = NEW.profile_id AND r.scope_id = NEW.scope_id
      AND r.key_id = NEW.key_id AND r.epoch = NEW.epoch
      AND r.writer_device_id = NEW.writer_device_id
      AND r.session_id = NEW.session_id AND r.expires_at > unixepoch('now')
      AND NEW.created_at >= r.created_at AND NEW.expires_at <= r.expires_at
      AND EXISTS (SELECT 1 FROM managed_upload_id_claims claim
        WHERE claim.household_id = NEW.household_id AND claim.kind = 'intent'
          AND claim.opaque_id = NEW.id AND claim.lineage = 'draft_reserved'
          AND claim.reservation_id = r.id)
      AND EXISTS (SELECT 1 FROM managed_upload_id_claims claim
        WHERE claim.household_id = NEW.household_id AND claim.kind = 'blob'
          AND claim.opaque_id = NEW.blob_id AND claim.lineage = 'draft_reserved'
          AND claim.reservation_id = r.id)
      AND ((NEW.role = 'content' AND r.content_intent_id = NEW.id
        AND r.content_blob_id = NEW.blob_id)
        OR (NEW.role = 'metadata' AND r.metadata_intent_id = NEW.id
          AND r.metadata_blob_id = NEW.blob_id))
  ) THEN RAISE(ABORT, 'draft intent does not match pair reservation') END;
END;

CREATE TRIGGER managed_non_day_intent_global_claim
AFTER INSERT ON managed_non_day_upload_intents
WHEN NEW.purpose = 'source'
BEGIN
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'intent', NEW.id, 'non_day', NULL);
  INSERT INTO managed_upload_id_claims VALUES
    (NEW.household_id, 'blob', NEW.blob_id, 'non_day', NULL);
END;

-- This view is a defense-in-depth recheck for intermediate nonce/chunk writes.
-- The application must also verify same-origin CSRF and the signed client
-- action; neither can be inferred from a database row.
CREATE VIEW managed_live_non_day_intents AS
SELECT i.household_id, i.id
FROM managed_non_day_upload_intents i
JOIN managed_devices d ON d.household_id = i.household_id
  AND d.id = i.writer_device_id
JOIN managed_grant_heads g ON g.household_id = i.household_id
  AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id
  AND g.subject_device_id = i.writer_device_id
JOIN managed_sessions s ON s.household_id = i.household_id
  AND s.id = i.session_id AND s.account_id = d.account_id
JOIN managed_memberships m ON m.household_id = d.household_id
  AND m.account_id = d.account_id
JOIN managed_accounts a ON a.id = m.account_id
JOIN managed_families f ON f.id = i.household_id
JOIN managed_scopes sc ON sc.household_id = i.household_id
  AND sc.profile_id = i.profile_id AND sc.id = i.scope_id
JOIN managed_profiles p ON p.household_id = i.household_id
  AND p.id = i.profile_id
JOIN managed_key_identities k ON k.household_id = i.household_id
  AND k.key_id = i.key_id AND k.epoch = i.epoch
WHERE i.consumed_at IS NULL AND i.expires_at > unixepoch('now')
  AND d.state = 'active' AND (g.capability_mask & 2) = 2
  AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
  AND s.account_auth_version = a.auth_version
  AND s.membership_auth_version = m.auth_version
  AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
  AND sc.state = 'active' AND sc.kind = i.purpose AND p.state = 'active'
  AND k.profile_id = i.profile_id AND k.scope_id = i.scope_id
  AND k.purpose = i.purpose;

-- Draft clients must open BOTH intent leases in one quota-checked BEGIN IMMEDIATE
-- transaction before either ciphertext object is written. A sequential
-- content-then-metadata lease flow is intentionally rejected: it could admit
-- only half of a draft and evade aggregate pre-write reservation.
CREATE TABLE managed_non_day_staging_leases (
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
    REFERENCES managed_non_day_upload_intents(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_non_day_lease_authority
BEFORE INSERT ON managed_non_day_staging_leases
BEGIN
  SELECT CASE WHEN NEW.committed_at IS NOT NULL
      OR NEW.opened_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_non_day_upload_intents i
    JOIN managed_devices d ON d.household_id = i.household_id
      AND d.id = i.writer_device_id
    JOIN managed_grant_heads g ON g.household_id = i.household_id
      AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id
      AND g.subject_device_id = i.writer_device_id
    JOIN managed_sessions s ON s.household_id = i.household_id
      AND s.id = i.session_id AND s.account_id = d.account_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = i.household_id
    JOIN managed_scopes sc ON sc.household_id = i.household_id
      AND sc.profile_id = i.profile_id AND sc.id = i.scope_id
    JOIN managed_profiles p ON p.household_id = i.household_id
      AND p.id = i.profile_id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND i.consumed_at IS NULL AND i.expires_at > unixepoch('now')
      AND NEW.reserved_bytes = 33 + i.plaintext_bytes + 32 * i.chunk_count
      AND d.state = 'active' AND (g.capability_mask & 2) = 2
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
      AND sc.state = 'active' AND sc.kind = i.purpose AND p.state = 'active'
      AND (i.purpose = 'source' OR (EXISTS (
        SELECT 1 FROM managed_draft_reservations r
        WHERE r.household_id = i.household_id
          AND r.id = i.draft_reservation_id
          AND r.expires_at > unixepoch('now')) AND (
        SELECT COUNT(*) FROM managed_non_day_upload_intents peer
        WHERE peer.household_id = i.household_id
          AND peer.draft_reservation_id = i.draft_reservation_id
          AND peer.purpose = 'draft' AND peer.consumed_at IS NULL
          AND peer.expires_at > unixepoch('now')) = 2))
  ) THEN RAISE(ABORT, 'non-day lease lacks complete authorized intent') END;
END;

CREATE TABLE managed_non_day_nonce_reservations (
  household_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  intent_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  reserved_at INTEGER NOT NULL CHECK (reserved_at > 0),
  PRIMARY KEY (household_id, key_id, epoch, nonce),
  UNIQUE (household_id, intent_id, chunk_index),
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_non_day_upload_intents(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_non_day_nonce_intent_match
BEFORE INSERT ON managed_non_day_nonce_reservations
BEGIN
  SELECT CASE WHEN NEW.reserved_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_non_day_upload_intents i
    JOIN managed_non_day_staging_leases l ON l.household_id = i.household_id
      AND l.intent_id = i.id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND i.key_id = NEW.key_id AND i.epoch = NEW.epoch
      AND NEW.chunk_index < i.chunk_count AND i.consumed_at IS NULL
      AND i.expires_at > unixepoch('now') AND l.committed_at IS NULL
      AND (i.purpose = 'source' OR 2 = (
        SELECT COUNT(*) FROM managed_non_day_upload_intents peer
        JOIN managed_non_day_staging_leases peer_lease
          ON peer_lease.household_id = peer.household_id
          AND peer_lease.intent_id = peer.id
        WHERE peer.household_id = i.household_id
          AND peer.draft_reservation_id = i.draft_reservation_id
          AND peer.purpose = 'draft'))
      AND EXISTS (SELECT 1 FROM managed_live_non_day_intents live
        WHERE live.household_id = i.household_id AND live.id = i.id)
  ) THEN RAISE(ABORT, 'non-day nonce lacks live leased intent') END;
END;

CREATE TRIGGER managed_non_day_nonce_global_claim
AFTER INSERT ON managed_non_day_nonce_reservations
BEGIN
  INSERT INTO managed_ciphertext_nonce_claims VALUES
    (NEW.household_id, NEW.key_id, NEW.epoch, NEW.nonce, 'non_day',
      NEW.intent_id, NEW.chunk_index, NEW.reserved_at);
END;

CREATE TABLE managed_non_day_blob_chunks (
  household_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (chunk_index BETWEEN 0 AND 99),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  storage_object_id TEXT NOT NULL CHECK (
    length(storage_object_id) = 32 AND storage_object_id NOT GLOB '*[^0-9a-f]*'
  ),
  ciphertext_bytes INTEGER NOT NULL CHECK (
    ciphertext_bytes BETWEEN 16 AND 1048592
  ),
  ciphertext_sha256 BLOB NOT NULL CHECK (length(ciphertext_sha256) = 32),
  PRIMARY KEY (household_id, intent_id, chunk_index),
  UNIQUE (household_id, storage_object_id),
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_non_day_upload_intents(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_non_day_chunk_matches_reservation
BEFORE INSERT ON managed_non_day_blob_chunks
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_non_day_nonce_reservations n
    JOIN managed_non_day_upload_intents i ON i.household_id = n.household_id
      AND i.id = n.intent_id
    WHERE n.household_id = NEW.household_id AND n.intent_id = NEW.intent_id
      AND n.chunk_index = NEW.chunk_index AND n.nonce = NEW.nonce
      AND i.consumed_at IS NULL AND i.expires_at > unixepoch('now')
      AND EXISTS (SELECT 1 FROM managed_live_non_day_intents live
        WHERE live.household_id = i.household_id AND live.id = i.id)
      AND NEW.ciphertext_bytes = 16 + max(0, min(1048576,
        i.plaintext_bytes - NEW.chunk_index * 1048576))
  ) THEN RAISE(ABORT, 'non-day chunk does not match nonce or size') END;
END;

CREATE TRIGGER managed_non_day_object_global_claim
AFTER INSERT ON managed_non_day_blob_chunks
BEGIN
  INSERT INTO managed_storage_object_claims VALUES
    (NEW.household_id, NEW.storage_object_id, 'non_day',
      NEW.intent_id, NEW.chunk_index);
END;

CREATE TABLE managed_non_day_committed_blobs (
  household_id TEXT NOT NULL,
  blob_id TEXT NOT NULL CHECK (
    length(blob_id) = 32 AND blob_id NOT GLOB '*[^0-9a-f]*'
  ),
  intent_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  purpose TEXT NOT NULL CHECK (purpose IN ('source', 'draft')),
  role TEXT NOT NULL CHECK (role IN ('original', 'content', 'metadata')),
  object_id TEXT NOT NULL CHECK (
    length(object_id) = 32 AND object_id NOT GLOB '*[^0-9a-f]*'
  ),
  aad_revision INTEGER NOT NULL CHECK (aad_revision BETWEEN 1 AND 4294967295),
  writer_device_id TEXT NOT NULL,
  wire_version INTEGER NOT NULL CHECK (wire_version = 2),
  wire_sha256 BLOB NOT NULL CHECK (length(wire_sha256) = 32),
  wire_bytes INTEGER NOT NULL CHECK (wire_bytes BETWEEN 65 AND 104860833),
  committed_at INTEGER NOT NULL CHECK (committed_at > 0),
  PRIMARY KEY (household_id, blob_id),
  UNIQUE (household_id, intent_id),
  FOREIGN KEY (household_id, intent_id)
    REFERENCES managed_non_day_upload_intents(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, writer_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_non_day_blob_commit_guard
BEFORE INSERT ON managed_non_day_committed_blobs
BEGIN
  SELECT CASE WHEN NEW.committed_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_non_day_upload_intents i
    JOIN managed_non_day_staging_leases l ON l.household_id = i.household_id
      AND l.intent_id = i.id
    JOIN managed_key_identities k ON k.household_id = i.household_id
      AND k.key_id = i.key_id AND k.epoch = i.epoch
    JOIN managed_scopes sc ON sc.household_id = i.household_id
      AND sc.profile_id = i.profile_id AND sc.id = i.scope_id
    JOIN managed_profiles p ON p.household_id = i.household_id
      AND p.id = i.profile_id
    JOIN managed_grant_heads g ON g.household_id = i.household_id
      AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id
      AND g.subject_device_id = i.writer_device_id
    JOIN managed_devices d ON d.household_id = i.household_id
      AND d.id = i.writer_device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_sessions s ON s.household_id = i.household_id
      AND s.id = i.session_id AND s.account_id = d.account_id
    JOIN managed_families f ON f.id = i.household_id
    WHERE i.household_id = NEW.household_id AND i.id = NEW.intent_id
      AND i.blob_id = NEW.blob_id AND i.profile_id = NEW.profile_id
      AND i.scope_id = NEW.scope_id AND i.key_id = NEW.key_id
      AND i.epoch = NEW.epoch AND i.purpose = NEW.purpose
      AND i.role = NEW.role AND i.object_id = NEW.object_id
      AND i.aad_revision = NEW.aad_revision
      AND i.writer_device_id = NEW.writer_device_id
      AND i.wire_version = NEW.wire_version AND i.consumed_at IS NULL
      AND i.expires_at > unixepoch('now') AND l.committed_at IS NULL
      AND l.reserved_bytes = NEW.wire_bytes
      AND k.profile_id = i.profile_id AND k.scope_id = i.scope_id
      AND k.purpose = i.purpose AND sc.kind = i.purpose
      AND sc.state = 'active' AND p.state = 'active'
      AND (g.capability_mask & 2) = 2 AND d.state = 'active'
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND NEW.wire_bytes = 33 + i.plaintext_bytes + 32 * i.chunk_count
      AND i.chunk_count = (
        SELECT COUNT(*) FROM managed_non_day_blob_chunks c
        WHERE c.household_id = i.household_id AND c.intent_id = i.id
      )
      AND i.chunk_count = (
        SELECT COUNT(*) FROM managed_non_day_nonce_reservations n
        WHERE n.household_id = i.household_id AND n.intent_id = i.id
      )
  ) THEN RAISE(ABORT, 'non-day blob lacks complete authorized intent') END;
END;

CREATE TRIGGER managed_non_day_blob_consume_intent
AFTER INSERT ON managed_non_day_committed_blobs
BEGIN
  UPDATE managed_non_day_upload_intents SET consumed_at = NEW.committed_at
  WHERE household_id = NEW.household_id AND id = NEW.intent_id;
  UPDATE managed_non_day_staging_leases SET committed_at = NEW.committed_at
  WHERE household_id = NEW.household_id AND intent_id = NEW.intent_id;
END;

-- A pair becomes visible as one pending review unit only after both distinct
-- draft blobs are committed. This does not approve or publish a care day.
-- The authorized device must decrypt metadata and verify its encrypted
-- contentBlobId reference; SQL cannot inspect ciphertext.
CREATE TABLE managed_pending_draft_pairs (
  household_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  content_blob_id TEXT NOT NULL,
  metadata_blob_id TEXT NOT NULL,
  author_device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  author_counter INTEGER NOT NULL CHECK (author_counter > 0),
  pair_sha256 BLOB NOT NULL CHECK (length(pair_sha256) = 32),
  paired_at INTEGER NOT NULL CHECK (paired_at > 0),
  PRIMARY KEY (household_id, reservation_id),
  UNIQUE (household_id, author_device_id, author_counter),
  FOREIGN KEY (household_id, reservation_id)
    REFERENCES managed_draft_reservations(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, content_blob_id)
    REFERENCES managed_non_day_committed_blobs(household_id, blob_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, metadata_blob_id)
    REFERENCES managed_non_day_committed_blobs(household_id, blob_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, author_device_id, author_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT,
  CHECK (content_blob_id != metadata_blob_id)
) STRICT;

CREATE TRIGGER managed_pending_draft_pair_guard
BEFORE INSERT ON managed_pending_draft_pairs
BEGIN
  SELECT CASE WHEN NEW.paired_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_draft_reservations r
    JOIN managed_non_day_committed_blobs content
      ON content.household_id = r.household_id
      AND content.blob_id = NEW.content_blob_id
    JOIN managed_non_day_upload_intents ci
      ON ci.household_id = content.household_id
      AND ci.id = content.intent_id
    JOIN managed_non_day_committed_blobs metadata
      ON metadata.household_id = r.household_id
      AND metadata.blob_id = NEW.metadata_blob_id
    JOIN managed_non_day_upload_intents mi
      ON mi.household_id = metadata.household_id
      AND mi.id = metadata.intent_id
    JOIN managed_scopes sc ON sc.household_id = r.household_id
      AND sc.profile_id = r.profile_id AND sc.id = r.scope_id
    JOIN managed_profiles p ON p.household_id = r.household_id
      AND p.id = r.profile_id
    JOIN managed_devices d ON d.household_id = r.household_id
      AND d.id = NEW.author_device_id
    JOIN managed_grant_heads g ON g.household_id = r.household_id
      AND g.profile_id = r.profile_id AND g.scope_id = r.scope_id
      AND g.subject_device_id = d.id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = r.household_id
    JOIN managed_sessions s ON s.household_id = r.household_id
      AND s.id = NEW.session_id AND s.account_id = d.account_id
    JOIN managed_signed_actions action ON action.household_id = r.household_id
      AND action.device_id = NEW.author_device_id
      AND action.counter = NEW.author_counter
    WHERE r.household_id = NEW.household_id AND r.id = NEW.reservation_id
      AND r.profile_id = NEW.profile_id AND r.scope_id = NEW.scope_id
      AND r.key_id = NEW.key_id AND r.epoch = NEW.epoch
      AND r.content_blob_id = NEW.content_blob_id
      AND r.metadata_blob_id = NEW.metadata_blob_id
      AND r.writer_device_id = NEW.author_device_id
      AND content.profile_id = r.profile_id AND metadata.profile_id = r.profile_id
      AND content.scope_id = r.scope_id AND metadata.scope_id = r.scope_id
      AND content.key_id = r.key_id AND metadata.key_id = r.key_id
      AND content.epoch = r.epoch AND metadata.epoch = r.epoch
      AND content.purpose = 'draft' AND metadata.purpose = 'draft'
      AND content.role = 'content' AND metadata.role = 'metadata'
      AND content.object_id != metadata.object_id
      AND ci.draft_reservation_id = r.id AND mi.draft_reservation_id = r.id
      AND ci.id = r.content_intent_id AND mi.id = r.metadata_intent_id
      AND ci.consumed_at IS NOT NULL AND mi.consumed_at IS NOT NULL
      AND sc.kind = 'draft' AND sc.state = 'active' AND p.state = 'active'
      AND d.state = 'active' AND (g.capability_mask & 2) = 2
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND action.action_kind = 'review'
      AND action.payload_sha256 = NEW.pair_sha256
  ) THEN RAISE(ABORT, 'draft pair lacks complete authorized ciphertext') END;
END;

CREATE TABLE managed_pending_draft_blob_uses (
  household_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('content', 'metadata')),
  PRIMARY KEY (household_id, blob_id),
  UNIQUE (household_id, reservation_id, role),
  FOREIGN KEY (household_id, reservation_id)
    REFERENCES managed_pending_draft_pairs(household_id, reservation_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, blob_id)
    REFERENCES managed_non_day_committed_blobs(household_id, blob_id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_pending_draft_pair_claim_blobs
AFTER INSERT ON managed_pending_draft_pairs
BEGIN
  INSERT INTO managed_pending_draft_blob_uses VALUES
    (NEW.household_id, NEW.content_blob_id, NEW.reservation_id, 'content');
  INSERT INTO managed_pending_draft_blob_uses VALUES
    (NEW.household_id, NEW.metadata_blob_id, NEW.reservation_id, 'metadata');
END;

CREATE TRIGGER managed_non_day_intent_update_guard
BEFORE UPDATE ON managed_non_day_upload_intents
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
      OR NEW.id IS NOT OLD.id OR NEW.profile_id IS NOT OLD.profile_id
      OR NEW.scope_id IS NOT OLD.scope_id OR NEW.key_id IS NOT OLD.key_id
      OR NEW.epoch IS NOT OLD.epoch OR NEW.purpose IS NOT OLD.purpose
      OR NEW.role IS NOT OLD.role
      OR NEW.draft_reservation_id IS NOT OLD.draft_reservation_id
      OR NEW.object_id IS NOT OLD.object_id
      OR NEW.aad_revision IS NOT OLD.aad_revision
      OR NEW.wire_version IS NOT OLD.wire_version
      OR NEW.blob_id IS NOT OLD.blob_id
      OR NEW.writer_device_id IS NOT OLD.writer_device_id
      OR NEW.session_id IS NOT OLD.session_id
      OR NEW.plaintext_bytes IS NOT OLD.plaintext_bytes
      OR NEW.chunk_count IS NOT OLD.chunk_count
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.expires_at IS NOT OLD.expires_at
      OR OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM managed_non_day_committed_blobs b
        WHERE b.household_id = NEW.household_id AND b.intent_id = NEW.id
          AND b.committed_at = NEW.consumed_at
      ) THEN RAISE(ABORT, 'non-day intent is immutable except commit') END;
END;

CREATE TRIGGER managed_non_day_lease_update_guard
BEFORE UPDATE ON managed_non_day_staging_leases
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
      OR NEW.intent_id IS NOT OLD.intent_id
      OR NEW.attempt_id IS NOT OLD.attempt_id
      OR NEW.reserved_bytes IS NOT OLD.reserved_bytes
      OR NEW.opened_at IS NOT OLD.opened_at
      OR OLD.committed_at IS NOT NULL OR NEW.committed_at IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM managed_non_day_committed_blobs b
        WHERE b.household_id = NEW.household_id AND b.intent_id = NEW.intent_id
          AND b.committed_at = NEW.committed_at
      ) THEN RAISE(ABORT, 'non-day lease is immutable except commit') END;
END;

CREATE TRIGGER managed_non_day_intent_no_delete
BEFORE DELETE ON managed_non_day_upload_intents BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_lease_no_delete
BEFORE DELETE ON managed_non_day_staging_leases BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_nonce_no_update
BEFORE UPDATE ON managed_non_day_nonce_reservations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_nonce_no_delete
BEFORE DELETE ON managed_non_day_nonce_reservations BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_chunk_no_update
BEFORE UPDATE ON managed_non_day_blob_chunks BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_chunk_no_delete
BEFORE DELETE ON managed_non_day_blob_chunks BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_blob_no_update
BEFORE UPDATE ON managed_non_day_committed_blobs BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_non_day_blob_no_delete
BEFORE DELETE ON managed_non_day_committed_blobs BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_pending_draft_pair_no_update
BEFORE UPDATE ON managed_pending_draft_pairs BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_pending_draft_pair_no_delete
BEFORE DELETE ON managed_pending_draft_pairs BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_pending_draft_blob_use_no_update
BEFORE UPDATE ON managed_pending_draft_blob_uses BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_pending_draft_blob_use_no_delete
BEFORE DELETE ON managed_pending_draft_blob_uses BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE VIEW managed_wire_occupancy AS
SELECT household_id, wire_bytes AS bytes FROM managed_committed_blobs
UNION ALL
SELECT household_id, reserved_bytes AS bytes FROM managed_staging_leases
WHERE committed_at IS NULL
UNION ALL
SELECT household_id, wire_bytes AS bytes FROM managed_non_day_committed_blobs
UNION ALL
SELECT household_id, reserved_bytes AS bytes FROM managed_non_day_staging_leases
WHERE committed_at IS NULL;

CREATE INDEX managed_non_day_intents_by_expiry
ON managed_non_day_upload_intents(expires_at, consumed_at);
CREATE INDEX managed_non_day_blobs_by_scope
ON managed_non_day_committed_blobs(household_id, profile_id, scope_id, committed_at);
CREATE INDEX managed_non_day_leases_by_family
ON managed_non_day_staging_leases(household_id, committed_at);
CREATE INDEX managed_pending_draft_pairs_by_scope
ON managed_pending_draft_pairs(household_id, profile_id, scope_id, paired_at);
