import Database from "better-sqlite3";

import { assertManagedSchema } from "./managedSchemaGuard.js";
import { verifyScopeEnvelopeAction,
  type ScopeEnvelopeRowCandidate,
  type SignedScopeEnvelopeActionRow } from "./verifyScopeEnvelopeAction.js";
import { verifyScopeEnvelopeBackfill,
  type ScopeEnvelopeBackfillRowCandidate } from
  "./verifyScopeEnvelopeBackfill.js";

const ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type AuthRow = { householdId: string; purpose: string;
  recipientDeviceId: string; recipientPublicKey: Buffer;
  currentGrantHead: Buffer };
type BaseEnvelopeDbRow = {
  household_id: string; profile_id: string; scope_id: string;
  key_id: string; epoch: number; purpose: string;
  recipient_device_id: string; key_commitment: Buffer;
  recipient_key_sha256: Buffer; wire_version: number; wire: Buffer;
  wire_sha256: Buffer; signed_payload_sha256: Buffer;
  issuer_device_id: string; issuer_counter: number;
  session_id: string; created_at: number;
};
type OrdinaryDbRow = BaseEnvelopeDbRow & {
  active_key_head_sha256: Buffer; grant_head_sha256: Buffer;
};
type BackfillDbRow = BaseEnvelopeDbRow & {
  historical_activation_sequence: number;
  historical_activation_sha256: Buffer;
  current_active_key_sequence: number;
  current_active_key_head_sha256: Buffer;
  current_grant_sequence: number;
  current_grant_head_sha256: Buffer;
};
type ActionDbRow = { household_id: string; device_id: string;
  counter: number; action_kind: string; payload_sha256: Buffer;
  previous_action_sha256: Buffer | null; action_sha256: Buffer;
  signature: Buffer; created_at: number; issuer_public_key: Buffer };
type PriorDbRow = { action_sha256: Buffer };
type ActiveEventRow = { epoch: number };

export type VerifiedManagedEnvelopeRead = {
  kind: "ordinary" | "historical-backfill";
  row: ScopeEnvelopeRowCandidate | ScopeEnvelopeBackfillRowCandidate;
  action: SignedScopeEnvelopeActionRow;
  issuerSigningPublicKey: Uint8Array;
  /** This is a server snapshot, not an independently witnessed latest head. */
  currentGrantHeadSha256: string;
};

export class ManagedScopeEnvelopeReadDenied extends Error {
  constructor() {
    super("Encrypted scope key not found.");
    this.name = "ManagedScopeEnvelopeReadDenied";
  }
}

/**
 * UNMOUNTED ciphertext-only candidate read. tokenSha256 must be derived by
 * trusted server code from the HttpOnly session cookie, never from a caller
 * field. The selected device comes from an immutable session binding, never
 * a caller field. This is still UNMOUNTED until the binding service verifies
 * a fresh enrolled-device signature and the managed schema is tested.
 * The active account, bound device and grant are reloaded on EVERY call. Historical
 * issuers need not remain active; a revoked selected device is denied.
 * Previously downloaded keys cannot be revoked. A route also needs trusted
 * Origin/CORS, no-store responses and a client-side latest-head witness;
 * this server snapshot cannot defeat a rolled-back database.
 */
export function readAccountScopedScopeEnvelopeCandidateV2(db: Database.Database, input: {
  tokenSha256: string;
  careProfileId: string;
  opaqueScopeId: string;
  keyId: string;
  keyEpoch: number;
}): VerifiedManagedEnvelopeRead {
  try {
    if (typeof input.tokenSha256 !== "string" || !SHA256.test(input.tokenSha256) ||
      ![input.careProfileId, input.opaqueScopeId, input.keyId]
        .every((value) => typeof value === "string" && ID.test(value)) ||
      !Number.isSafeInteger(input.keyEpoch) || input.keyEpoch < 1 ||
      input.keyEpoch > 0xffffffff)
      throw new ManagedScopeEnvelopeReadDenied();
    const token = Buffer.from(input.tokenSha256, "hex");
    const read = db.transaction((): VerifiedManagedEnvelopeRead => {
      assertManagedSchema(db);
      const auth = db.prepare<[Buffer, string, string], AuthRow>(
        "SELECT s.household_id AS householdId, sc.kind AS purpose, " +
        "d.id AS recipientDeviceId, " +
        "d.encryption_public_key AS recipientPublicKey, " +
        "g.head_sha256 AS currentGrantHead " +
        "FROM managed_sessions s " +
        "JOIN managed_accounts a ON a.id = s.account_id " +
        "JOIN managed_memberships m ON m.household_id = s.household_id " +
        "AND m.account_id = s.account_id " +
        "JOIN managed_families f ON f.id = s.household_id " +
        "JOIN managed_session_device_bindings binding " +
        "ON binding.household_id = s.household_id " +
        "AND binding.account_id = s.account_id " +
        "AND binding.session_id = s.id " +
        "JOIN managed_devices d ON d.household_id = s.household_id " +
        "AND d.account_id = s.account_id AND d.id = binding.device_id " +
        "JOIN managed_profiles p ON p.household_id = s.household_id " +
        "JOIN managed_scopes sc ON sc.household_id = p.household_id " +
        "AND sc.profile_id = p.id " +
        "JOIN managed_current_scope_keys current_key " +
        "ON current_key.household_id = sc.household_id " +
        "AND current_key.profile_id = sc.profile_id " +
        "AND current_key.scope_id = sc.id " +
        "JOIN managed_active_key_events current_event " +
        "ON current_event.household_id = current_key.household_id " +
        "AND current_event.profile_id = current_key.profile_id " +
        "AND current_event.scope_id = current_key.scope_id " +
        "AND current_event.sequence = current_key.sequence " +
        "AND current_event.event_sha256 = current_key.head_sha256 " +
        "AND current_event.key_id = current_key.key_id " +
        "AND current_event.epoch = current_key.epoch " +
        "AND current_event.purpose = sc.kind " +
        "JOIN managed_grant_heads g ON g.household_id = sc.household_id " +
        "AND g.profile_id = sc.profile_id AND g.scope_id = sc.id " +
        "AND g.subject_device_id = d.id " +
        "JOIN managed_grant_events current_grant " +
        "ON current_grant.household_id = g.household_id " +
        "AND current_grant.profile_id = g.profile_id " +
        "AND current_grant.scope_id = g.scope_id " +
        "AND current_grant.subject_device_id = g.subject_device_id " +
        "AND current_grant.sequence = g.sequence " +
        "AND current_grant.event_sha256 = g.head_sha256 " +
        "WHERE s.token_sha256 = ? AND p.id = ? AND sc.id = ? " +
        "AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now') " +
        "AND s.account_auth_version = a.auth_version " +
        "AND s.membership_auth_version = m.auth_version " +
        "AND a.state = 'active' AND m.state = 'active' " +
        "AND f.state = 'active' AND d.state = 'active' " +
        "AND p.state = 'active' AND sc.state = 'active' " +
        "AND g.capability_mask = current_grant.capability_mask " +
        "AND (g.capability_mask & 1) = 1 " +
        "AND (current_grant.capability_mask & 1) = 1",
      ).get(token, input.careProfileId, input.opaqueScopeId);
      if (!auth) throw new ManagedScopeEnvelopeReadDenied();
      const tuple = [auth.householdId, input.keyId,
        input.keyEpoch, auth.recipientDeviceId] as const;
      // Corrupt/imported dual rows fail closed. Never fall back after an
      // invalid v2 row, and never query legacy v1 material.
      const ordinary = db.prepare<[
        string, string, number, string
      ], OrdinaryDbRow>(
        "SELECT * FROM managed_scope_envelopes_v2 " +
        "WHERE household_id = ? AND key_id = ? AND epoch = ? " +
        "AND recipient_device_id = ?",
      ).get(...tuple);
      const backfill = db.prepare<[
        string, string, number, string
      ], BackfillDbRow>(
        "SELECT * FROM managed_scope_envelope_backfills_v2 " +
        "WHERE household_id = ? AND key_id = ? AND epoch = ? " +
        "AND recipient_device_id = ?",
      ).get(...tuple);
      if (ordinary && backfill) throw new ManagedScopeEnvelopeReadDenied();
      if (ordinary) return verifyOrdinary(db, ordinary, auth, input);
      if (!backfill) throw new ManagedScopeEnvelopeReadDenied();
      return verifyBackfill(db, backfill, auth, input);
    });
    return read.deferred();
  } catch { throw new ManagedScopeEnvelopeReadDenied(); }
}

function verifyOrdinary(db: Database.Database, raw: OrdinaryDbRow,
  auth: AuthRow, request: Parameters<typeof readAccountScopedScopeEnvelopeCandidateV2>[1]):
  VerifiedManagedEnvelopeRead {
  const row = baseRow(raw, auth, request);
  requireKeyIdentity(db, row, raw.key_commitment);
  const ordinary: ScopeEnvelopeRowCandidate = { ...row,
    activeKeyHeadSha256: digest(raw.active_key_head_sha256),
    grantHeadSha256: digest(raw.grant_head_sha256) };
  requireEvent(db, "managed_active_key_events",
    "household_id = ? AND profile_id = ? AND scope_id = ? " +
    "AND key_id = ? AND epoch = ? AND purpose = ? " +
    "AND key_commitment = ? AND event_sha256 = ?",
    [row.householdId, row.careProfileId, row.opaqueScopeId,
      row.keyId, row.keyEpoch, row.purpose,
      raw.key_commitment, raw.active_key_head_sha256]);
  requireEvent(db, "managed_grant_events",
    "household_id = ? AND profile_id = ? AND scope_id = ? " +
    "AND subject_device_id = ? AND event_sha256 = ? " +
    "AND (capability_mask & 1) = 1",
    [row.householdId, row.careProfileId, row.opaqueScopeId,
      row.recipientDeviceId, raw.grant_head_sha256]);
  const { action, issuerPublicKey, previous } = signedAction(db, raw);
  verifyScopeEnvelopeAction({ row: ordinary, action,
    enrolledIssuerSigningPublicKey: issuerPublicKey,
    enrolledRecipientEncryptionPublicKey: auth.recipientPublicKey,
    currentActiveKeyHeadSha256: ordinary.activeKeyHeadSha256,
    currentGrantHeadSha256: ordinary.grantHeadSha256,
    expectedPreviousActionSha256: previous,
    authenticatedSessionId: row.sessionId,
    authenticatedIssuerDeviceId: row.issuerDeviceId });
  return { kind: "ordinary", row: ordinary, action,
    issuerSigningPublicKey: Uint8Array.from(issuerPublicKey),
    currentGrantHeadSha256: digest(auth.currentGrantHead) };
}

function verifyBackfill(db: Database.Database, raw: BackfillDbRow,
  auth: AuthRow, request: Parameters<typeof readAccountScopedScopeEnvelopeCandidateV2>[1]):
  VerifiedManagedEnvelopeRead {
  const row = baseRow(raw, auth, request);
  requireKeyIdentity(db, row, raw.key_commitment);
  // "current" in the signed backfill is the head at ISSUANCE, not at read.
  // Today's grant is checked separately by the authorization query above.
  // Comparing these snapshots to today's key head would hide older history
  // after another rotation; re-grant semantics still need a product decision.
  const backfill: ScopeEnvelopeBackfillRowCandidate = { ...row,
    historicalActivationSequence: safeBigint(raw.historical_activation_sequence),
    historicalActivationSha256: digest(raw.historical_activation_sha256),
    currentActiveKeySequence: safeBigint(raw.current_active_key_sequence),
    currentActiveKeyHeadSha256: digest(raw.current_active_key_head_sha256),
    currentGrantSequence: safeBigint(raw.current_grant_sequence),
    currentGrantHeadSha256: digest(raw.current_grant_head_sha256) };
  requireEvent(db, "managed_active_key_events",
    "household_id = ? AND profile_id = ? AND scope_id = ? " +
    "AND sequence = ? AND key_id = ? AND epoch = ? AND purpose = ? " +
    "AND key_commitment = ? AND event_sha256 = ?",
    [row.householdId, row.careProfileId, row.opaqueScopeId,
      raw.historical_activation_sequence, row.keyId, row.keyEpoch,
      row.purpose, raw.key_commitment, raw.historical_activation_sha256]);
  const currentEvent = db.prepare<[
    string, string, string, number, Buffer
  ], ActiveEventRow>(
    "SELECT epoch FROM managed_active_key_events " +
    "WHERE household_id = ? AND profile_id = ? AND scope_id = ? " +
    "AND sequence = ? AND event_sha256 = ?",
  ).get(row.householdId, row.careProfileId, row.opaqueScopeId,
    raw.current_active_key_sequence, raw.current_active_key_head_sha256);
  if (!currentEvent || !Number.isSafeInteger(currentEvent.epoch))
    throw new ManagedScopeEnvelopeReadDenied();
  requireEvent(db, "managed_grant_events",
    "household_id = ? AND profile_id = ? AND scope_id = ? " +
    "AND subject_device_id = ? AND sequence = ? AND event_sha256 = ? " +
    "AND (capability_mask & 1) = 1",
    [row.householdId, row.careProfileId, row.opaqueScopeId,
      row.recipientDeviceId, raw.current_grant_sequence,
      raw.current_grant_head_sha256]);
  const { action, issuerPublicKey, previous } = signedAction(db, raw);
  verifyScopeEnvelopeBackfill({ row: backfill, action,
    enrolledIssuerSigningPublicKey: issuerPublicKey,
    enrolledRecipientEncryptionPublicKey: auth.recipientPublicKey,
    historicalActivationSequence: backfill.historicalActivationSequence,
    historicalActivationSha256: backfill.historicalActivationSha256,
    currentActiveKeySequence: backfill.currentActiveKeySequence,
    currentActiveKeyEpoch: currentEvent.epoch,
    currentActiveKeyHeadSha256: backfill.currentActiveKeyHeadSha256,
    currentGrantSequence: backfill.currentGrantSequence,
    currentGrantHeadSha256: backfill.currentGrantHeadSha256,
    expectedPreviousActionSha256: previous,
    authenticatedSessionId: row.sessionId,
    authenticatedIssuerDeviceId: row.issuerDeviceId });
  return { kind: "historical-backfill", row: backfill, action,
    issuerSigningPublicKey: Uint8Array.from(issuerPublicKey),
    currentGrantHeadSha256: digest(auth.currentGrantHead) };
}

function baseRow(raw: BaseEnvelopeDbRow, auth: AuthRow,
  request: Parameters<typeof readAccountScopedScopeEnvelopeCandidateV2>[1]) {
  if (raw.household_id !== auth.householdId ||
    raw.profile_id !== request.careProfileId ||
    raw.scope_id !== request.opaqueScopeId ||
    raw.key_id !== request.keyId || raw.epoch !== request.keyEpoch ||
    raw.purpose !== auth.purpose ||
    raw.recipient_device_id !== auth.recipientDeviceId)
    throw new ManagedScopeEnvelopeReadDenied();
  return { householdId: raw.household_id, careProfileId: raw.profile_id,
    opaqueScopeId: raw.scope_id, keyId: raw.key_id,
    keyEpoch: raw.epoch, purpose: raw.purpose as ScopeEnvelopeRowCandidate["purpose"],
    recipientDeviceId: raw.recipient_device_id,
    keyCommitmentSha256: digest(raw.key_commitment),
    recipientKeySha256: digest(raw.recipient_key_sha256),
    wireVersion: raw.wire_version as 2,
    wire: Uint8Array.from(raw.wire), wireSha256: digest(raw.wire_sha256),
    signedPayloadSha256: digest(raw.signed_payload_sha256),
    issuerDeviceId: raw.issuer_device_id,
    issuerCounter: safeBigint(raw.issuer_counter),
    sessionId: raw.session_id, createdAt: safeBigint(raw.created_at) };
}

function signedAction(db: Database.Database, row: BaseEnvelopeDbRow): {
  action: SignedScopeEnvelopeActionRow;
  issuerPublicKey: Buffer;
  previous: string | null;
} {
  const stored = db.prepare<[string, string, number, string], ActionDbRow>(
    "SELECT a.*, issuer.signing_public_key AS issuer_public_key " +
    "FROM managed_signed_actions a " +
    "JOIN managed_sessions issuer_session " +
    "ON issuer_session.household_id = a.household_id " +
    "JOIN managed_session_device_bindings binding " +
    "ON binding.household_id = issuer_session.household_id " +
    "AND binding.account_id = issuer_session.account_id " +
    "AND binding.session_id = issuer_session.id " +
    "AND binding.device_id = a.device_id " +
    "JOIN managed_devices issuer ON issuer.household_id = a.household_id " +
    "AND issuer.account_id = issuer_session.account_id " +
    "AND issuer.id = binding.device_id " +
    "WHERE a.household_id = ? AND a.device_id = ? AND a.counter = ? " +
    "AND issuer_session.id = ?",
  ).get(row.household_id, row.issuer_device_id, row.issuer_counter,
    row.session_id);
  if (!stored) throw new ManagedScopeEnvelopeReadDenied();
  const counter = safeBigint(stored.counter);
  const prior = counter === 1n ? null : db.prepare<[
    string, string, number
  ], PriorDbRow>(
    "SELECT action_sha256 FROM managed_signed_actions " +
    "WHERE household_id = ? AND device_id = ? AND counter = ?",
  ).get(row.household_id, row.issuer_device_id, row.issuer_counter - 1);
  if (counter > 1n && !prior) throw new ManagedScopeEnvelopeReadDenied();
  const action: SignedScopeEnvelopeActionRow = {
    householdId: stored.household_id, deviceId: stored.device_id,
    counter, actionKind: stored.action_kind,
    payloadSha256: digest(stored.payload_sha256),
    previousActionSha256: stored.previous_action_sha256 === null ? null :
      digest(stored.previous_action_sha256),
    actionSha256: digest(stored.action_sha256),
    signature: Uint8Array.from(stored.signature),
    createdAt: safeBigint(stored.created_at) };
  return { action, issuerPublicKey: stored.issuer_public_key,
    previous: prior ? digest(prior.action_sha256) : null };
}

function requireEvent(db: Database.Database, table: string, where: string,
  values: unknown[]): void {
  // These two SQL fragments are private constants at every call site.
  if (table !== "managed_active_key_events" &&
    table !== "managed_grant_events") throw new ManagedScopeEnvelopeReadDenied();
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`).get(...values))
    throw new ManagedScopeEnvelopeReadDenied();
}

function requireKeyIdentity(db: Database.Database,
  row: ReturnType<typeof baseRow>, commitment: Buffer): void {
  if (!db.prepare<[
    string, string, string, string, number, string, Buffer
  ]>(
    "SELECT 1 FROM managed_key_identities WHERE household_id = ? " +
    "AND profile_id = ? AND scope_id = ? AND key_id = ? AND epoch = ? " +
    "AND purpose = ? AND key_commitment = ? LIMIT 1",
  ).get(row.householdId, row.careProfileId, row.opaqueScopeId,
    row.keyId, row.keyEpoch, row.purpose, commitment))
    throw new ManagedScopeEnvelopeReadDenied();
}

function safeBigint(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ManagedScopeEnvelopeReadDenied();
  return BigInt(value);
}

function digest(value: Buffer): string {
  if (!Buffer.isBuffer(value) || value.byteLength !== 32)
    throw new ManagedScopeEnvelopeReadDenied();
  return value.toString("hex");
}
