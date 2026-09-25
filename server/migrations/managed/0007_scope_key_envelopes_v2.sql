-- Managed hosted E2EE schema, independent lineage, version 7.
-- CREATE ONLY. Never apply to community/trusted-local or real-family data.
-- HPKE base mode encrypts a key to a device; it does NOT authenticate the
-- issuer or grant. The runtime must verify the exact domain-separated Ed25519
-- envelope action and canonical payload before insertion. That signed payload
-- must bind every row column, the 240-byte wire digest, recipient enrollment,
-- current grant head, active key head, issuer/session/counter and timestamp.
-- SQL checks the canonical v2 header, current relational authority and
-- append-only provenance; it cannot calculate SHA-256 or open HPKE ciphertext.

CREATE TABLE managed_scope_envelopes_v2 (
  household_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key_id TEXT NOT NULL CHECK (
    length(key_id) = 32 AND key_id NOT GLOB '*[^0-9a-f]*'
  ),
  epoch INTEGER NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  purpose TEXT NOT NULL CHECK (purpose IN ('day', 'source', 'draft', 'index')),
  recipient_device_id TEXT NOT NULL,
  key_commitment BLOB NOT NULL CHECK (length(key_commitment) = 32),
  recipient_key_sha256 BLOB NOT NULL CHECK (length(recipient_key_sha256) = 32),
  wire_version INTEGER NOT NULL CHECK (wire_version = 2),
  wire BLOB NOT NULL CHECK (length(wire) = 240),
  wire_sha256 BLOB NOT NULL CHECK (length(wire_sha256) = 32),
  active_key_head_sha256 BLOB NOT NULL CHECK (length(active_key_head_sha256) = 32),
  grant_head_sha256 BLOB NOT NULL CHECK (length(grant_head_sha256) = 32),
  signed_payload_sha256 BLOB NOT NULL CHECK (length(signed_payload_sha256) = 32),
  issuer_device_id TEXT NOT NULL,
  issuer_counter INTEGER NOT NULL CHECK (issuer_counter > 0),
  session_id TEXT NOT NULL,
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
    REFERENCES managed_signed_actions(household_id, device_id, counter)
    ON DELETE RESTRICT,
  FOREIGN KEY (household_id, session_id)
    REFERENCES managed_sessions(household_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER managed_scope_envelope_v2_authority
BEFORE INSERT ON managed_scope_envelopes_v2
BEGIN
  SELECT CASE WHEN NEW.created_at NOT BETWEEN unixepoch('now') - 5
      AND unixepoch('now') + 5 OR NOT EXISTS (
    SELECT 1 FROM managed_scopes sc
    JOIN managed_profiles p ON p.household_id = sc.household_id
      AND p.id = sc.profile_id
    JOIN managed_key_identities k ON k.household_id = sc.household_id
      AND k.profile_id = sc.profile_id AND k.scope_id = sc.id
      AND k.key_id = NEW.key_id AND k.epoch = NEW.epoch
    JOIN managed_current_scope_keys current_key
      ON current_key.household_id = sc.household_id
      AND current_key.profile_id = sc.profile_id
      AND current_key.scope_id = sc.id
      AND current_key.key_id = NEW.key_id AND current_key.epoch = NEW.epoch
    JOIN managed_grant_heads g ON g.household_id = sc.household_id
      AND g.profile_id = sc.profile_id AND g.scope_id = sc.id
      AND g.subject_device_id = NEW.recipient_device_id
    JOIN managed_devices recipient ON recipient.household_id = sc.household_id
      AND recipient.id = NEW.recipient_device_id
    JOIN managed_memberships recipient_member
      ON recipient_member.household_id = recipient.household_id
      AND recipient_member.account_id = recipient.account_id
    JOIN managed_accounts recipient_account
      ON recipient_account.id = recipient_member.account_id
    JOIN managed_signed_actions action
      ON action.household_id = sc.household_id
      AND action.device_id = NEW.issuer_device_id
      AND action.counter = NEW.issuer_counter
    JOIN managed_devices issuer ON issuer.household_id = sc.household_id
      AND issuer.id = NEW.issuer_device_id
    JOIN managed_memberships issuer_member
      ON issuer_member.household_id = issuer.household_id
      AND issuer_member.account_id = issuer.account_id
    JOIN managed_accounts issuer_account ON issuer_account.id = issuer.account_id
    JOIN managed_sessions s ON s.household_id = issuer.household_id
      AND s.id = NEW.session_id AND s.account_id = issuer.account_id
    JOIN managed_families f ON f.id = sc.household_id
    WHERE sc.household_id = NEW.household_id
      AND sc.profile_id = NEW.profile_id AND sc.id = NEW.scope_id
      AND sc.kind = NEW.purpose AND sc.state = 'active' AND p.state = 'active'
      AND k.purpose = NEW.purpose AND k.key_commitment = NEW.key_commitment
      AND current_key.head_sha256 = NEW.active_key_head_sha256
      AND (g.capability_mask & 1) = 1
      AND g.head_sha256 = NEW.grant_head_sha256
      AND recipient.state = 'active'
      AND recipient_member.state = 'active'
      AND recipient_account.state = 'active'
      AND action.action_kind = 'envelope'
      AND action.payload_sha256 = NEW.signed_payload_sha256
      AND action.created_at <= NEW.created_at
      AND issuer.state = 'active'
      AND issuer_member.role = 'owner' AND issuer_member.state = 'active'
      AND issuer_account.state = 'active' AND f.state = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now')
      AND s.account_auth_version = issuer_account.auth_version
      AND s.membership_auth_version = issuer_member.auth_version
      AND NOT EXISTS (SELECT 1 FROM managed_scope_envelopes old
        WHERE old.household_id = NEW.household_id
          AND old.issuer_device_id = NEW.issuer_device_id
          AND old.issuer_counter = NEW.issuer_counter)
  ) THEN RAISE(ABORT, 'v2 envelope lacks current owner and recipient grant') END;
END;

CREATE TRIGGER managed_scope_envelope_v2_wire_match
BEFORE INSERT ON managed_scope_envelopes_v2
BEGIN
  SELECT CASE WHEN NEW.wire_version != 2 OR length(NEW.wire) != 240
      OR substr(NEW.wire, 1, 8) != x'41444b5902010000'
      OR lower(hex(substr(NEW.wire, 9, 16))) != NEW.household_id
      OR lower(hex(substr(NEW.wire, 25, 16))) != NEW.profile_id
      OR lower(hex(substr(NEW.wire, 41, 16))) != NEW.scope_id
      OR lower(hex(substr(NEW.wire, 57, 16))) != NEW.key_id
      OR lower(hex(substr(NEW.wire, 73, 16))) != NEW.recipient_device_id
      OR hex(substr(NEW.wire, 89, 4)) != printf('%08X', NEW.epoch)
      OR substr(NEW.wire, 93, 1) != CASE NEW.purpose
        WHEN 'day' THEN x'01' WHEN 'source' THEN x'02'
        WHEN 'draft' THEN x'03' WHEN 'index' THEN x'04' END
      OR substr(NEW.wire, 94, 3) != x'000000'
      OR substr(NEW.wire, 97, 32) != NEW.key_commitment
      OR substr(NEW.wire, 129, 32) != NEW.recipient_key_sha256
    THEN RAISE(ABORT, 'v2 envelope wire/header mismatch') END;
END;

-- v1 day wires remain immutable historical material, but new issuance is
-- closed. The managed runtime must not silently downgrade v2 to day-v1.
CREATE TRIGGER managed_day_v1_envelope_no_new_issuance
BEFORE INSERT ON managed_scope_envelopes
BEGIN SELECT RAISE(ABORT, 'day v1 envelope issuance closed'); END;

CREATE TRIGGER managed_scope_envelope_v2_no_update
BEFORE UPDATE ON managed_scope_envelopes_v2 BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER managed_scope_envelope_v2_no_delete
BEFORE DELETE ON managed_scope_envelopes_v2 BEGIN SELECT RAISE(ABORT, 'immutable'); END;

CREATE INDEX managed_scope_envelopes_v2_by_recipient
ON managed_scope_envelopes_v2(household_id, recipient_device_id, scope_id);
