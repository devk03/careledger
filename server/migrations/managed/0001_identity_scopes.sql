-- Adeno hosted E2EE schema, independent lineage, version 1.
-- CREATE ONLY. Never apply to the community/trusted-local database.
-- The migration runner must enable foreign_keys and wrap this file in one transaction.
-- SQL constraints are defense in depth, not signature verification. The server must
-- verify each canonical payload and Ed25519 signature before inserting an action.
-- For grant events, event_sha256 is the canonical grant payload digest; the
-- verified payload must bind every event column, including its predecessor.
-- This migration does not enable the managed runtime or admit real records.

CREATE TABLE managed_families (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('active', 'frozen')),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE managed_accounts (
  id TEXT PRIMARY KEY CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  login_email TEXT NOT NULL UNIQUE CHECK (
    length(login_email) BETWEEN 3 AND 254 AND login_email = lower(login_email)
  ),
  password_hash TEXT NOT NULL CHECK (length(password_hash) BETWEEN 40 AND 512),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'disabled')),
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  email_verified_at INTEGER CHECK (email_verified_at > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0)
) STRICT;

CREATE TABLE managed_memberships (
  household_id TEXT NOT NULL REFERENCES managed_families(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('adult', 'child')),
  role TEXT NOT NULL CHECK (role IN ('owner', 'adult', 'child')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'disabled')),
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  disabled_at INTEGER CHECK (disabled_at >= created_at),
  PRIMARY KEY (household_id, account_id),
  CHECK ((member_kind = 'child') = (role = 'child'))
) STRICT;

CREATE TABLE managed_profiles (
  household_id TEXT NOT NULL REFERENCES managed_families(id) ON DELETE RESTRICT,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  created_by_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  archived_at INTEGER CHECK (archived_at >= created_at),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, created_by_account_id)
    REFERENCES managed_memberships(household_id, account_id) ON DELETE RESTRICT,
  CHECK ((state = 'archived') = (archived_at IS NOT NULL))
) STRICT;

CREATE TABLE managed_sessions (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL,
  token_sha256 BLOB NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  csrf_secret BLOB NOT NULL CHECK (length(csrf_secret) = 32),
  account_auth_version INTEGER NOT NULL CHECK (account_auth_version > 0),
  membership_auth_version INTEGER NOT NULL CHECK (membership_auth_version > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at >= created_at),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, account_id, id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES managed_memberships(household_id, account_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_invitations (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  token_sha256 BLOB NOT NULL UNIQUE CHECK (length(token_sha256) = 32),
  recipient_email_hmac BLOB NOT NULL CHECK (length(recipient_email_hmac) = 32),
  issuer_account_id TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('adult', 'child')),
  role TEXT NOT NULL CHECK (role IN ('adult', 'child')),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 86400
  ),
  consumed_at INTEGER CHECK (consumed_at BETWEEN created_at AND expires_at),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, issuer_account_id)
    REFERENCES managed_memberships(household_id, account_id) ON DELETE RESTRICT,
  CHECK ((member_kind = 'child') = (role = 'child'))
) STRICT;

CREATE TABLE managed_devices (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL,
  enrollment_challenge_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  encryption_public_key BLOB NOT NULL CHECK (length(encryption_public_key) = 32),
  signing_public_key BLOB NOT NULL CHECK (length(signing_public_key) = 32),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  activated_at INTEGER CHECK (activated_at >= created_at),
  revoked_at INTEGER CHECK (revoked_at >= created_at),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, enrollment_challenge_id),
  UNIQUE (household_id, encryption_public_key),
  UNIQUE (household_id, signing_public_key),
  FOREIGN KEY (household_id, account_id)
    REFERENCES managed_memberships(household_id, account_id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, enrollment_challenge_id)
    REFERENCES managed_enrollment_challenges(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'pending' AND activated_at IS NULL AND revoked_at IS NULL)
    OR (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE managed_enrollment_challenges (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  challenge_sha256 BLOB NOT NULL UNIQUE CHECK (length(challenge_sha256) = 32),
  encryption_public_key BLOB NOT NULL CHECK (length(encryption_public_key) = 32),
  signing_public_key BLOB NOT NULL CHECK (length(signing_public_key) = 32),
  proof_signature BLOB CHECK (length(proof_signature) = 64),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 600
  ),
  consumed_at INTEGER CHECK (consumed_at BETWEEN created_at AND expires_at),
  PRIMARY KEY (household_id, id),
  FOREIGN KEY (household_id, account_id, session_id)
    REFERENCES managed_sessions(household_id, account_id, id) ON DELETE RESTRICT,
  CHECK ((consumed_at IS NULL) = (proof_signature IS NULL))
) STRICT;

CREATE TRIGGER managed_invitation_owner_only
BEFORE INSERT ON managed_invitations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_memberships m
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE m.household_id = NEW.household_id AND m.account_id = NEW.issuer_account_id
      AND m.role = 'owner' AND m.state = 'active' AND a.state = 'active'
      AND f.state = 'active'
  ) THEN RAISE(ABORT, 'invite requires active family owner') END;
END;

CREATE TRIGGER managed_challenge_session_only
BEFORE INSERT ON managed_enrollment_challenges
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_sessions s JOIN managed_memberships m
      ON m.household_id = s.household_id AND m.account_id = s.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE s.household_id = NEW.household_id AND s.id = NEW.session_id
      AND s.account_id = NEW.account_id AND s.revoked_at IS NULL
      AND s.expires_at > unixepoch('now') AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'enrollment needs current active session') END;
END;

CREATE TRIGGER managed_device_pending_only
BEFORE INSERT ON managed_devices
BEGIN
  SELECT CASE WHEN NEW.state != 'pending'
    THEN RAISE(ABORT, 'device must begin pending') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_enrollment_challenges c
    WHERE c.household_id = NEW.household_id AND c.id = NEW.enrollment_challenge_id
      AND c.account_id = NEW.account_id AND c.consumed_at IS NULL
      AND c.encryption_public_key = NEW.encryption_public_key
      AND c.signing_public_key = NEW.signing_public_key
  ) THEN RAISE(ABORT, 'device has no matching enrollment challenge') END;
END;

CREATE TRIGGER managed_device_activation
BEFORE UPDATE OF state ON managed_devices
WHEN OLD.state = 'pending' AND NEW.state = 'active'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_enrollment_challenges c
    JOIN managed_sessions s ON s.household_id = c.household_id
      AND s.id = c.session_id AND s.account_id = c.account_id
    JOIN managed_memberships m ON m.household_id = c.household_id
      AND m.account_id = c.account_id
    JOIN managed_accounts a ON a.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE c.household_id = NEW.household_id AND c.id = NEW.enrollment_challenge_id
      AND c.account_id = NEW.account_id AND c.consumed_at IS NOT NULL
      AND c.proof_signature IS NOT NULL AND c.expires_at > unixepoch('now')
      AND c.consumed_at <= NEW.activated_at
      AND c.encryption_public_key = NEW.encryption_public_key
      AND c.signing_public_key = NEW.signing_public_key
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'device activation lacks verified enrollment') END;
END;

CREATE TABLE managed_scopes (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('day', 'source', 'draft', 'index')),
  state TEXT NOT NULL CHECK (state IN ('active', 'archived')),
  created_by_device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, profile_id, id),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, profile_id)
    REFERENCES managed_profiles(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, created_by_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE managed_signed_actions (
  household_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  counter INTEGER NOT NULL CHECK (counter > 0),
  action_kind TEXT NOT NULL CHECK (action_kind IN (
    'scope', 'key', 'grant', 'envelope', 'recovery', 'revision',
    'review', 'index_head', 'checkpoint', 'retention'
  )),
  payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
  previous_action_sha256 BLOB CHECK (length(previous_action_sha256) = 32),
  action_sha256 BLOB NOT NULL CHECK (length(action_sha256) = 32),
  signature BLOB NOT NULL CHECK (length(signature) = 64),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, device_id, counter),
  UNIQUE (household_id, device_id, action_sha256),
  FOREIGN KEY (household_id, device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
  CHECK (
    (counter = 1 AND previous_action_sha256 IS NULL)
    OR (counter > 1 AND previous_action_sha256 IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER managed_signed_actions_order
BEFORE INSERT ON managed_signed_actions
BEGIN
  SELECT CASE WHEN NEW.counter != 1 + COALESCE((
    SELECT MAX(counter) FROM managed_signed_actions
    WHERE household_id = NEW.household_id AND device_id = NEW.device_id
  ), 0) THEN RAISE(ABORT, 'signed action counter is not sequential') END;
  SELECT CASE WHEN NEW.counter > 1 AND NEW.previous_action_sha256 != (
    SELECT action_sha256 FROM managed_signed_actions
    WHERE household_id = NEW.household_id AND device_id = NEW.device_id
    ORDER BY counter DESC LIMIT 1
  ) THEN RAISE(ABORT, 'signed action predecessor mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_devices d JOIN managed_memberships m
      ON m.household_id = d.household_id AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE d.household_id = NEW.household_id AND d.id = NEW.device_id
      AND d.state = 'active' AND m.state = 'active' AND u.state = 'active'
      AND f.state = 'active'
  ) THEN RAISE(ABORT, 'inactive signing device') END;
END;

CREATE TABLE managed_key_identities (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK (length(key_id) = 32 AND key_id NOT GLOB '*[^0-9a-f]*'),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('day', 'source', 'draft', 'index')),
  key_commitment BLOB NOT NULL CHECK (length(key_commitment) = 32),
  signed_payload_sha256 BLOB NOT NULL CHECK (length(signed_payload_sha256) = 32),
  issuer_device_id TEXT NOT NULL,
  issuer_counter INTEGER NOT NULL CHECK (issuer_counter > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, key_id, epoch),
  UNIQUE (household_id, profile_id, scope_id, epoch),
  UNIQUE (household_id, issuer_device_id, issuer_counter),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, issuer_device_id, issuer_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_key_purpose_matches_scope
BEFORE INSERT ON managed_key_identities
BEGIN
  SELECT CASE WHEN NEW.purpose != (
    SELECT kind FROM managed_scopes WHERE household_id = NEW.household_id
      AND profile_id = NEW.profile_id AND id = NEW.scope_id
  ) THEN RAISE(ABORT, 'key purpose does not match scope') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_signed_actions a JOIN managed_devices d
      ON d.household_id = a.household_id AND d.id = a.device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE a.household_id = NEW.household_id AND a.device_id = NEW.issuer_device_id
      AND a.counter = NEW.issuer_counter AND a.action_kind = 'key'
      AND a.payload_sha256 = NEW.signed_payload_sha256
      AND d.state = 'active' AND m.state = 'active' AND u.state = 'active'
      AND f.state = 'active' AND m.role = 'owner'
  ) THEN RAISE(ABORT, 'key requires an active owner signed action') END;
END;

CREATE TABLE managed_grant_heads (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  subject_device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  head_sha256 BLOB CHECK (length(head_sha256) = 32),
  capability_mask INTEGER NOT NULL DEFAULT 0 CHECK (capability_mask BETWEEN 0 AND 7),
  updated_at INTEGER NOT NULL CHECK (updated_at > 0),
  PRIMARY KEY (household_id, profile_id, scope_id, subject_device_id),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, subject_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
  CHECK ((sequence = 0) = (head_sha256 IS NULL))
) STRICT;

CREATE TABLE managed_grant_events (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  subject_device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_sha256 BLOB CHECK (length(previous_sha256) = 32),
  event_sha256 BLOB NOT NULL CHECK (length(event_sha256) = 32),
  capability_mask INTEGER NOT NULL CHECK (capability_mask BETWEEN 0 AND 7),
  issuer_device_id TEXT NOT NULL,
  issuer_counter INTEGER NOT NULL CHECK (issuer_counter > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, profile_id, scope_id, subject_device_id, sequence),
  UNIQUE (household_id, issuer_device_id, issuer_counter),
  FOREIGN KEY (household_id, profile_id, scope_id, subject_device_id)
    REFERENCES managed_grant_heads(
      household_id, profile_id, scope_id, subject_device_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, issuer_device_id, issuer_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter) ON DELETE RESTRICT,
  CHECK ((sequence = 1) = (previous_sha256 IS NULL))
) STRICT;

CREATE TRIGGER managed_grant_head_initial
BEFORE INSERT ON managed_grant_heads
BEGIN
  SELECT CASE WHEN NEW.sequence != 0 OR NEW.head_sha256 IS NOT NULL
    OR NEW.capability_mask != 0
    THEN RAISE(ABORT, 'grant head must start empty') END;
END;

CREATE TRIGGER managed_grant_head_event_only
BEFORE UPDATE ON managed_grant_heads
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
    OR NEW.profile_id IS NOT OLD.profile_id OR NEW.scope_id IS NOT OLD.scope_id
    OR NEW.subject_device_id IS NOT OLD.subject_device_id
    THEN RAISE(ABORT, 'grant head identity is immutable') END;
  SELECT CASE WHEN NEW.sequence != OLD.sequence + 1 OR NOT EXISTS (
    SELECT 1 FROM managed_grant_events e
    WHERE e.household_id = NEW.household_id AND e.profile_id = NEW.profile_id
      AND e.scope_id = NEW.scope_id AND e.subject_device_id = NEW.subject_device_id
      AND e.sequence = NEW.sequence AND e.event_sha256 = NEW.head_sha256
      AND e.capability_mask = NEW.capability_mask AND e.created_at = NEW.updated_at
  ) THEN RAISE(ABORT, 'grant head requires matching event') END;
END;

CREATE TRIGGER managed_grant_head_no_delete
BEFORE DELETE ON managed_grant_heads BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_grant_event_cas
BEFORE INSERT ON managed_grant_events
BEGIN
  SELECT CASE WHEN NEW.sequence != 1 + (
    SELECT sequence FROM managed_grant_heads WHERE household_id = NEW.household_id
      AND profile_id = NEW.profile_id AND scope_id = NEW.scope_id
      AND subject_device_id = NEW.subject_device_id
  ) THEN RAISE(ABORT, 'stale grant sequence') END;
  SELECT CASE WHEN NEW.previous_sha256 IS NOT (
    SELECT head_sha256 FROM managed_grant_heads WHERE household_id = NEW.household_id
      AND profile_id = NEW.profile_id AND scope_id = NEW.scope_id
      AND subject_device_id = NEW.subject_device_id
  ) THEN RAISE(ABORT, 'stale grant predecessor') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_signed_actions a
    JOIN managed_devices d ON d.household_id = a.household_id AND d.id = a.device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE a.household_id = NEW.household_id AND a.device_id = NEW.issuer_device_id
      AND a.counter = NEW.issuer_counter AND a.action_kind = 'grant'
      AND a.payload_sha256 = NEW.event_sha256 AND d.state = 'active'
      AND m.state = 'active' AND u.state = 'active' AND f.state = 'active'
      AND m.role = 'owner'
  ) THEN RAISE(ABORT, 'grant requires an active owner signed action') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_devices d JOIN managed_memberships m
      ON m.household_id = d.household_id AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE d.household_id = NEW.household_id AND d.id = NEW.subject_device_id
      AND d.state = 'active' AND m.state = 'active' AND u.state = 'active'
      AND f.state = 'active'
  ) THEN RAISE(ABORT, 'grant subject is inactive') END;
END;

CREATE TRIGGER managed_grant_event_advance
AFTER INSERT ON managed_grant_events
BEGIN
  UPDATE managed_grant_heads SET sequence = NEW.sequence,
    head_sha256 = NEW.event_sha256, capability_mask = NEW.capability_mask,
    updated_at = NEW.created_at
  WHERE household_id = NEW.household_id AND profile_id = NEW.profile_id
    AND scope_id = NEW.scope_id AND subject_device_id = NEW.subject_device_id;
END;

CREATE TABLE managed_scope_envelopes (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  recipient_device_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose = 'day'),
  wire_version INTEGER NOT NULL CHECK (wire_version = 1),
  wire BLOB NOT NULL CHECK (length(wire) = 188),
  signed_payload_sha256 BLOB NOT NULL CHECK (length(signed_payload_sha256) = 32),
  issuer_device_id TEXT NOT NULL,
  issuer_counter INTEGER NOT NULL CHECK (issuer_counter > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, key_id, epoch, recipient_device_id),
  UNIQUE (household_id, issuer_device_id, issuer_counter),
  FOREIGN KEY (household_id, profile_id, scope_id)
    REFERENCES managed_scopes(household_id, profile_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, key_id, epoch)
    REFERENCES managed_key_identities(household_id, key_id, epoch) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, recipient_device_id)
    REFERENCES managed_devices(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, issuer_device_id, issuer_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter) ON DELETE RESTRICT,
  CHECK (purpose = 'day' AND wire_version = 1 AND length(wire) = 188)
) STRICT;

CREATE TRIGGER managed_envelope_scope_and_grant
BEFORE INSERT ON managed_scope_envelopes
BEGIN
  SELECT CASE WHEN NEW.purpose != (
    SELECT purpose FROM managed_key_identities
    WHERE household_id = NEW.household_id AND key_id = NEW.key_id
      AND epoch = NEW.epoch
  ) THEN RAISE(ABORT, 'envelope purpose mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_key_identities WHERE household_id = NEW.household_id
      AND key_id = NEW.key_id AND epoch = NEW.epoch
      AND profile_id = NEW.profile_id AND scope_id = NEW.scope_id
  ) THEN RAISE(ABORT, 'envelope scope mismatch') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_grant_heads g JOIN managed_devices d
      ON d.household_id = g.household_id AND d.id = g.subject_device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE g.household_id = NEW.household_id AND g.profile_id = NEW.profile_id
      AND g.scope_id = NEW.scope_id AND g.subject_device_id = NEW.recipient_device_id
      AND (g.capability_mask & 1) = 1 AND d.state = 'active' AND m.state = 'active'
      AND u.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'recipient has no current view grant') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_signed_actions a JOIN managed_devices d
      ON d.household_id = a.household_id AND d.id = a.device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE a.household_id = NEW.household_id AND a.device_id = NEW.issuer_device_id
      AND a.counter = NEW.issuer_counter AND a.action_kind = 'envelope'
      AND a.payload_sha256 = NEW.signed_payload_sha256
      AND d.state = 'active' AND m.state = 'active' AND u.state = 'active'
      AND f.state = 'active' AND m.role = 'owner'
  ) THEN RAISE(ABORT, 'envelope requires an active owner signed action') END;
END;

CREATE TABLE managed_owner_recovery (
  household_id TEXT NOT NULL REFERENCES managed_families(id) ON DELETE RESTRICT,
  owner_root_epoch INTEGER NOT NULL CHECK (owner_root_epoch > 0),
  root_commitment BLOB NOT NULL CHECK (length(root_commitment) = 32),
  kdf_profile TEXT NOT NULL CHECK (kdf_profile = 'argon2id-19mib-2-v1'),
  salt BLOB NOT NULL CHECK (length(salt) = 16),
  envelope_id BLOB NOT NULL CHECK (length(envelope_id) = 16),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) = 48),
  signed_payload_sha256 BLOB NOT NULL CHECK (length(signed_payload_sha256) = 32),
  issuer_device_id TEXT NOT NULL,
  issuer_counter INTEGER NOT NULL CHECK (issuer_counter > 0),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  PRIMARY KEY (household_id, owner_root_epoch),
  UNIQUE (household_id, envelope_id),
  UNIQUE (household_id, issuer_device_id, issuer_counter),
  FOREIGN KEY (household_id, issuer_device_id, issuer_counter)
    REFERENCES managed_signed_actions(household_id, device_id, counter) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_recovery_signed_owner
BEFORE INSERT ON managed_owner_recovery
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_signed_actions a JOIN managed_devices d
      ON d.household_id = a.household_id AND d.id = a.device_id
    JOIN managed_memberships m ON m.household_id = d.household_id
      AND m.account_id = d.account_id
    JOIN managed_accounts u ON u.id = m.account_id
    JOIN managed_families f ON f.id = m.household_id
    WHERE a.household_id = NEW.household_id AND a.device_id = NEW.issuer_device_id
      AND a.counter = NEW.issuer_counter AND a.action_kind = 'recovery'
      AND a.payload_sha256 = NEW.signed_payload_sha256
      AND d.state = 'active' AND m.state = 'active' AND u.state = 'active'
      AND f.state = 'active' AND m.role = 'owner'
  ) THEN RAISE(ABORT, 'recovery requires an active owner signed action') END;
END;

CREATE TRIGGER managed_signed_actions_no_update
BEFORE UPDATE ON managed_signed_actions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_signed_actions_no_delete
BEFORE DELETE ON managed_signed_actions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_key_identities_no_update
BEFORE UPDATE ON managed_key_identities BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_key_identities_no_delete
BEFORE DELETE ON managed_key_identities BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_grant_events_no_update
BEFORE UPDATE ON managed_grant_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_grant_events_no_delete
BEFORE DELETE ON managed_grant_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_scope_envelopes_no_update
BEFORE UPDATE ON managed_scope_envelopes BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_scope_envelopes_no_delete
BEFORE DELETE ON managed_scope_envelopes BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_owner_recovery_no_update
BEFORE UPDATE ON managed_owner_recovery BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_owner_recovery_no_delete
BEFORE DELETE ON managed_owner_recovery BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_accounts_update_guard
BEFORE UPDATE ON managed_accounts
BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.login_email IS NOT OLD.login_email
    OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'account identity is immutable') END;
  SELECT CASE WHEN OLD.state = 'disabled' AND NEW.state != 'disabled'
    THEN RAISE(ABORT, 'disabled account is terminal') END;
  SELECT CASE WHEN OLD.state = 'active' AND NEW.state = 'pending'
    THEN RAISE(ABORT, 'account cannot return to pending') END;
  SELECT CASE WHEN NEW.auth_version < OLD.auth_version
    OR (NEW.password_hash IS NOT OLD.password_hash OR NEW.state IS NOT OLD.state
      OR NEW.email_verified_at IS NOT OLD.email_verified_at)
      AND NEW.auth_version <= OLD.auth_version
    THEN RAISE(ABORT, 'account auth version must advance') END;
END;
CREATE TRIGGER managed_accounts_no_delete
BEFORE DELETE ON managed_accounts BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_memberships_update_guard
BEFORE UPDATE ON managed_memberships
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
    OR NEW.account_id IS NOT OLD.account_id OR NEW.member_kind IS NOT OLD.member_kind
    OR NEW.role IS NOT OLD.role OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'membership identity is immutable') END;
  SELECT CASE WHEN OLD.state = 'disabled' AND NEW.state != 'disabled'
    OR OLD.state = 'active' AND NEW.state = 'pending'
    THEN RAISE(ABORT, 'membership state cannot rewind') END;
  SELECT CASE WHEN NEW.auth_version < OLD.auth_version
    OR NEW.state IS NOT OLD.state AND NEW.auth_version <= OLD.auth_version
    THEN RAISE(ABORT, 'membership auth version must advance') END;
  SELECT CASE WHEN OLD.disabled_at IS NOT NULL
    AND NEW.disabled_at IS NOT OLD.disabled_at
    THEN RAISE(ABORT, 'disabled timestamp is immutable') END;
END;
CREATE TRIGGER managed_memberships_no_delete
BEFORE DELETE ON managed_memberships BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_sessions_update_guard
BEFORE UPDATE ON managed_sessions
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id
    OR NEW.account_id IS NOT OLD.account_id OR NEW.token_sha256 IS NOT OLD.token_sha256
    OR NEW.csrf_secret IS NOT OLD.csrf_secret
    OR NEW.account_auth_version IS NOT OLD.account_auth_version
    OR NEW.membership_auth_version IS NOT OLD.membership_auth_version
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
    THEN RAISE(ABORT, 'session is immutable except first revocation') END;
END;
CREATE TRIGGER managed_sessions_no_delete
BEFORE DELETE ON managed_sessions BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_devices_update_guard
BEFORE UPDATE ON managed_devices
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id
    OR NEW.account_id IS NOT OLD.account_id
    OR NEW.enrollment_challenge_id IS NOT OLD.enrollment_challenge_id
    OR NEW.encryption_public_key IS NOT OLD.encryption_public_key
    OR NEW.signing_public_key IS NOT OLD.signing_public_key
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at
    OR OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
    THEN RAISE(ABORT, 'device identity and past timestamps are immutable') END;
  SELECT CASE WHEN OLD.state = 'revoked' AND NEW.state != 'revoked'
    OR OLD.state = 'active' AND NEW.state = 'pending'
    THEN RAISE(ABORT, 'device state cannot rewind') END;
END;
CREATE TRIGGER managed_devices_no_delete
BEFORE DELETE ON managed_devices BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_invitations_update_guard
BEFORE UPDATE ON managed_invitations
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id
    OR NEW.token_sha256 IS NOT OLD.token_sha256
    OR NEW.recipient_email_hmac IS NOT OLD.recipient_email_hmac
    OR NEW.issuer_account_id IS NOT OLD.issuer_account_id
    OR NEW.member_kind IS NOT OLD.member_kind OR NEW.role IS NOT OLD.role
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at
    THEN RAISE(ABORT, 'invitation is immutable except first consumption') END;
  SELECT CASE WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND (NEW.expires_at <= unixepoch('now') OR NOT EXISTS (
      SELECT 1 FROM managed_memberships m
      JOIN managed_accounts a ON a.id = m.account_id
      JOIN managed_families f ON f.id = m.household_id
      WHERE m.household_id = NEW.household_id
        AND m.account_id = NEW.issuer_account_id AND m.role = 'owner'
        AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
    )) THEN RAISE(ABORT, 'expired or unauthorized invitation') END;
END;
CREATE TRIGGER managed_invitations_no_delete
BEFORE DELETE ON managed_invitations BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_enrollment_challenges_update_guard
BEFORE UPDATE ON managed_enrollment_challenges
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id
    OR NEW.account_id IS NOT OLD.account_id OR NEW.session_id IS NOT OLD.session_id
    OR NEW.challenge_sha256 IS NOT OLD.challenge_sha256
    OR NEW.encryption_public_key IS NOT OLD.encryption_public_key
    OR NEW.signing_public_key IS NOT OLD.signing_public_key
    OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
    OR OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS NOT OLD.consumed_at
    OR OLD.proof_signature IS NOT NULL
      AND NEW.proof_signature IS NOT OLD.proof_signature
    THEN RAISE(ABORT, 'challenge is immutable except first consumption') END;
  SELECT CASE WHEN OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
    AND (NEW.expires_at <= unixepoch('now') OR NOT EXISTS (
      SELECT 1 FROM managed_sessions s JOIN managed_memberships m
        ON m.household_id = s.household_id AND m.account_id = s.account_id
      JOIN managed_accounts a ON a.id = m.account_id
      JOIN managed_families f ON f.id = m.household_id
      WHERE s.household_id = NEW.household_id AND s.id = NEW.session_id
        AND s.account_id = NEW.account_id AND s.revoked_at IS NULL
        AND s.expires_at > unixepoch('now')
        AND s.account_auth_version = a.auth_version
        AND s.membership_auth_version = m.auth_version
        AND m.state = 'active' AND a.state = 'active' AND f.state = 'active'
    )) THEN RAISE(ABORT, 'expired or unauthorized enrollment') END;
END;
CREATE TRIGGER managed_enrollment_challenges_no_delete
BEFORE DELETE ON managed_enrollment_challenges BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_profiles_update_guard
BEFORE UPDATE ON managed_profiles
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id OR NEW.id IS NOT OLD.id
    OR NEW.created_by_account_id IS NOT OLD.created_by_account_id
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.archived_at IS NOT NULL AND NEW.archived_at IS NOT OLD.archived_at
    OR OLD.state = 'archived' AND NEW.state != 'archived'
    THEN RAISE(ABORT, 'profile identity and archive are immutable') END;
END;
CREATE TRIGGER managed_profiles_no_delete
BEFORE DELETE ON managed_profiles BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_scopes_update_guard
BEFORE UPDATE ON managed_scopes
BEGIN
  SELECT CASE WHEN NEW.household_id IS NOT OLD.household_id
    OR NEW.profile_id IS NOT OLD.profile_id OR NEW.id IS NOT OLD.id
    OR NEW.kind IS NOT OLD.kind
    OR NEW.created_by_device_id IS NOT OLD.created_by_device_id
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.state = 'archived' AND NEW.state != 'archived'
    THEN RAISE(ABORT, 'scope identity and archive are immutable') END;
END;
CREATE TRIGGER managed_scopes_no_delete
BEFORE DELETE ON managed_scopes BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE TRIGGER managed_families_no_delete
BEFORE DELETE ON managed_families BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE INDEX managed_memberships_by_account
ON managed_memberships(account_id, state);
CREATE INDEX managed_sessions_by_expiry
ON managed_sessions(expires_at, revoked_at);
CREATE INDEX managed_devices_by_account
ON managed_devices(household_id, account_id, state);
CREATE INDEX managed_scopes_by_profile
ON managed_scopes(household_id, profile_id, kind, state);
CREATE INDEX managed_envelopes_by_recipient
ON managed_scope_envelopes(household_id, recipient_device_id, profile_id, scope_id);
