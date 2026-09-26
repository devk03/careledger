-- Managed hosted E2EE schema, independent lineage, version 10.
-- CREATE ONLY. Never apply to community/trusted-local or real-family data.
-- Draft 0009 binds one enrolled device to a session after one-use proof.
-- These insert guards make the bound device mandatory for v2 key-envelope
-- issuance and day-ciphertext admission. Older triggers still enforce current
-- owner/grant/session/key authority; a binding alone is never authorization.
-- Other session-scoped managed writes, especially non-day/draft and grant
-- actions, are NOT covered here and remain disabled pending separate review.
-- This migration has not been executed; it does not mount managed routes.

CREATE TRIGGER managed_v2_envelope_bound_issuer
BEFORE INSERT ON managed_scope_envelopes_v2
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_session_device_bindings b
    WHERE b.household_id = NEW.household_id
      AND b.session_id = NEW.session_id
      AND b.device_id = NEW.issuer_device_id
  ) THEN RAISE(ABORT, 'scope envelope issuer is not session-bound') END;
END;

CREATE TRIGGER managed_v2_backfill_bound_issuer
BEFORE INSERT ON managed_scope_envelope_backfills_v2
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_session_device_bindings b
    WHERE b.household_id = NEW.household_id
      AND b.session_id = NEW.session_id
      AND b.device_id = NEW.issuer_device_id
  ) THEN RAISE(ABORT, 'historical envelope issuer is not session-bound') END;
END;

CREATE TRIGGER managed_day_intent_bound_writer
BEFORE INSERT ON managed_upload_intents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_session_device_bindings b
    WHERE b.household_id = NEW.household_id
      AND b.session_id = NEW.session_id
      AND b.device_id = NEW.writer_device_id
  ) THEN RAISE(ABORT, 'day upload writer is not session-bound') END;
END;

CREATE TRIGGER managed_day_lease_bound_writer
BEFORE INSERT ON managed_staging_leases
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_upload_intents i
    JOIN managed_session_device_bindings b
      ON b.household_id = i.household_id
      AND b.session_id = i.session_id
      AND b.device_id = i.writer_device_id
    WHERE i.household_id = NEW.household_id
      AND i.id = NEW.intent_id
  ) THEN RAISE(ABORT, 'day staging lease writer is not session-bound') END;
END;

CREATE TRIGGER managed_day_blob_bound_writer
BEFORE INSERT ON managed_committed_blobs
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM managed_upload_intents i
    JOIN managed_session_device_bindings b
      ON b.household_id = i.household_id
      AND b.session_id = i.session_id
      AND b.device_id = i.writer_device_id
    WHERE i.household_id = NEW.household_id
      AND i.id = NEW.intent_id
      AND i.writer_device_id = NEW.writer_device_id
  ) THEN RAISE(ABORT, 'day blob writer is not session-bound') END;
END;
