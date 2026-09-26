-- Managed hosted E2EE schema, independent lineage, version 9.
-- CREATE ONLY. Never apply to community/trusted-local or real-family data.
-- A login session may bind to exactly one enrolled signing device after a
-- fresh, session-bound Ed25519 proof. SQL cannot verify a signature: trusted
-- runtime must verify a domain-separated canonical payload against the
-- enrolled device key, then consume the challenge and insert the binding in
-- one write transaction. Never accept a caller-selected device as read access.
-- A stolen cookie after binding can still fetch ciphertext and metadata;
-- content remains device-encrypted, but stronger per-request possession is a
-- separate launch decision. These tables do not mount managed routes.

CREATE UNIQUE INDEX managed_device_account_identity
ON managed_devices(household_id, account_id, id);

CREATE TABLE managed_session_device_challenges (
  household_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  nonce_sha256 BLOB NOT NULL UNIQUE CHECK (length(nonce_sha256) = 32),
  audience_sha256 BLOB NOT NULL CHECK (length(audience_sha256) = 32),
  created_at INTEGER NOT NULL CHECK (created_at > 0),
  expires_at INTEGER NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 300
  ),
  consumed_at INTEGER CHECK (consumed_at BETWEEN created_at AND expires_at),
  proof_signature BLOB CHECK (length(proof_signature) = 64),
  PRIMARY KEY (household_id, id),
  UNIQUE (household_id, account_id, session_id, device_id, id),
  FOREIGN KEY (household_id, account_id, session_id)
    REFERENCES managed_sessions(household_id, account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, account_id, device_id)
    REFERENCES managed_devices(household_id, account_id, id) ON DELETE RESTRICT,
  CHECK ((consumed_at IS NULL) = (proof_signature IS NULL))
) STRICT;

CREATE TABLE managed_session_device_bindings (
  household_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL CHECK (bound_at > 0),
  PRIMARY KEY (household_id, session_id),
  UNIQUE (household_id, challenge_id),
  FOREIGN KEY (household_id, account_id, session_id)
    REFERENCES managed_sessions(household_id, account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, account_id, device_id)
    REFERENCES managed_devices(household_id, account_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, account_id, session_id, device_id, challenge_id)
    REFERENCES managed_session_device_challenges(
      household_id, account_id, session_id, device_id, id
    ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX managed_session_device_challenge_expiry
ON managed_session_device_challenges(household_id, expires_at)
WHERE consumed_at IS NULL;

CREATE TRIGGER managed_session_device_challenge_authority
BEFORE INSERT ON managed_session_device_challenges
BEGIN
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NEW.expires_at <= unixepoch('now')
      OR NEW.expires_at > unixepoch('now') + 300
      OR NEW.consumed_at IS NOT NULL OR NEW.proof_signature IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM managed_session_device_challenges old
        WHERE (old.household_id = NEW.household_id AND old.id = NEW.id)
          OR old.nonce_sha256 = NEW.nonce_sha256
      )
      OR NOT EXISTS (
    SELECT 1 FROM managed_sessions s
    JOIN managed_accounts a ON a.id = s.account_id
    JOIN managed_memberships m ON m.household_id = s.household_id
      AND m.account_id = s.account_id
    JOIN managed_families f ON f.id = s.household_id
    JOIN managed_devices d ON d.household_id = s.household_id
      AND d.account_id = s.account_id
    WHERE s.household_id = NEW.household_id
      AND s.account_id = NEW.account_id AND s.id = NEW.session_id
      AND d.id = NEW.device_id AND d.state = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND a.state = 'active' AND m.state = 'active' AND f.state = 'active'
  ) THEN RAISE(ABORT, 'device challenge needs current session') END;
END;

CREATE TRIGGER managed_session_device_challenge_consume_once
BEFORE UPDATE ON managed_session_device_challenges
BEGIN
  SELECT CASE WHEN OLD.consumed_at IS NOT NULL
      OR NEW.consumed_at IS NULL OR NEW.proof_signature IS NULL
      OR NEW.household_id != OLD.household_id OR NEW.id != OLD.id
      OR NEW.account_id != OLD.account_id
      OR NEW.session_id != OLD.session_id OR NEW.device_id != OLD.device_id
      OR NEW.nonce_sha256 != OLD.nonce_sha256
      OR NEW.audience_sha256 != OLD.audience_sha256
      OR NEW.created_at != OLD.created_at OR NEW.expires_at != OLD.expires_at
      OR NEW.expires_at <= unixepoch('now')
      OR NEW.consumed_at NOT BETWEEN unixepoch('now') - 5
        AND unixepoch('now') + 5
  THEN RAISE(ABORT, 'device challenge invalid or already consumed') END;
END;

CREATE TRIGGER managed_session_device_binding_authority
BEFORE INSERT ON managed_session_device_bindings
BEGIN
  SELECT CASE WHEN NEW.bound_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR EXISTS (
    SELECT 1 FROM managed_session_device_bindings old
    WHERE old.household_id = NEW.household_id
      AND old.session_id = NEW.session_id
  ) OR EXISTS (
    SELECT 1 FROM managed_session_device_bindings old
    WHERE old.household_id = NEW.household_id
      AND old.challenge_id = NEW.challenge_id
  ) OR NOT EXISTS (
    SELECT 1 FROM managed_session_device_challenges c
    JOIN managed_sessions s ON s.household_id = c.household_id
      AND s.account_id = c.account_id AND s.id = c.session_id
    JOIN managed_accounts a ON a.id = s.account_id
    JOIN managed_memberships m ON m.household_id = s.household_id
      AND m.account_id = s.account_id
    JOIN managed_families f ON f.id = s.household_id
    JOIN managed_devices d ON d.household_id = c.household_id
      AND d.account_id = c.account_id AND d.id = c.device_id
    WHERE c.household_id = NEW.household_id AND c.id = NEW.challenge_id
      AND c.account_id = NEW.account_id AND c.session_id = NEW.session_id
      AND c.device_id = NEW.device_id AND c.consumed_at = NEW.bound_at
      AND c.proof_signature IS NOT NULL
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = a.auth_version
      AND s.membership_auth_version = m.auth_version
      AND a.state = 'active' AND m.state = 'active' AND f.state = 'active'
      AND d.state = 'active'
  ) THEN RAISE(ABORT, 'device binding needs verified live challenge') END;
END;

CREATE TRIGGER managed_session_device_challenge_no_delete
BEFORE DELETE ON managed_session_device_challenges
BEGIN SELECT RAISE(ABORT, 'device challenges are immutable'); END;

CREATE TRIGGER managed_session_device_binding_no_update
BEFORE UPDATE ON managed_session_device_bindings
BEGIN SELECT RAISE(ABORT, 'device bindings are immutable'); END;

CREATE TRIGGER managed_session_device_binding_no_delete
BEFORE DELETE ON managed_session_device_bindings
BEGIN SELECT RAISE(ABORT, 'device bindings are immutable'); END;
