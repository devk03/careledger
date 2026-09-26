import Database from "better-sqlite3";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";
import { verifyScopeEnvelopeBackfill,
  type ScopeEnvelopeBackfillRowCandidate } from
  "./verifyScopeEnvelopeBackfill.js";
import type { SignedScopeEnvelopeActionRow } from
  "./verifyScopeEnvelopeAction.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;

type IssuerRow = { householdId: string; sessionId: string;
  authenticatedDeviceId: string; csrfSecret: Buffer;
  signingPublicKey: Buffer };
type BackfillScopeRow = {
  recipientPublicKey: Buffer;
  keyCommitment: Buffer;
  historicalActivationSequence: number;
  historicalActivationSha256: Buffer;
  currentActiveKeySequence: number;
  currentActiveKeyEpoch: number;
  currentActiveKeyHeadSha256: Buffer;
  currentGrantSequence: number;
  currentGrantHeadSha256: Buffer;
};
type PriorRow = { counter: number; actionSha256: Buffer };

export class ManagedScopeEnvelopeBackfillIssueDenied extends Error {
  constructor() {
    super("The historical encrypted scope key could not be shared.");
    this.name = "ManagedScopeEnvelopeBackfillIssueDenied";
  }
}

/**
 * Unmounted, existing-schema-only v10 writer. The caller must first obtain the
 * person's explicit approval to share an OLD key, and the owner's device must
 * open that key and verify its commitment before rewrapping it. This function
 * cannot prove either consent or plaintext-key possession. It must receive an
 * already opened, private, integrity-checked managed SQLite connection; it
 * never creates a DB, applies migrations, exposes a route or authorizes reads.
 */
export function issueHistoricalScopeEnvelopeV2(db: Database.Database, input: {
  tokenSha256: string;
  csrfToken: string;
  row: ScopeEnvelopeBackfillRowCandidate;
  action: SignedScopeEnvelopeActionRow;
}): void {
  try {
    if (typeof input.tokenSha256 !== "string" ||
      !SHA256.test(input.tokenSha256) ||
      typeof input.csrfToken !== "string" || input.csrfToken.length > 256 ||
      !safePositiveSqlInteger(input.row.issuerCounter) ||
      !safePositiveSqlInteger(input.row.createdAt) ||
      !safePositiveSqlInteger(input.row.historicalActivationSequence) ||
      !safePositiveSqlInteger(input.row.currentActiveKeySequence) ||
      !safePositiveSqlInteger(input.row.currentGrantSequence))
      throw new ManagedScopeEnvelopeBackfillIssueDenied();
    const row = { ...input.row, wire: copyBytes(input.row.wire, 240) };
    const action = { ...input.action,
      signature: copyBytes(input.action.signature, 64) };
    const tokenSha256 = Buffer.from(input.tokenSha256, "hex");
    const csrfToken = input.csrfToken;
    const issue = db.transaction(() => {
      assertManagedSchema(db);
      const issuer = db.prepare<[Buffer, string, string], IssuerRow>(
        "SELECT s.household_id AS householdId, s.id AS sessionId, " +
        "binding.device_id AS authenticatedDeviceId, " +
        "s.csrf_secret AS csrfSecret, d.signing_public_key AS signingPublicKey " +
        "FROM managed_sessions s " +
        "JOIN managed_accounts a ON a.id = s.account_id " +
        "JOIN managed_memberships m ON m.household_id = s.household_id " +
        "AND m.account_id = s.account_id " +
        "JOIN managed_families f ON f.id = s.household_id " +
        "JOIN managed_session_device_bindings binding " +
        "ON binding.household_id = s.household_id " +
        "AND binding.account_id = s.account_id AND binding.session_id = s.id " +
        "JOIN managed_devices d ON d.household_id = s.household_id " +
        "AND d.account_id = s.account_id AND d.id = binding.device_id " +
        "WHERE s.token_sha256 = ? AND s.id = ? AND d.id = ? " +
        "AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now') " +
        "AND s.account_auth_version = a.auth_version " +
        "AND s.membership_auth_version = m.auth_version " +
        "AND a.state = 'active' AND a.email_verified_at IS NOT NULL " +
        "AND m.state = 'active' AND m.role = 'owner' " +
        "AND f.state = 'active' AND d.state = 'active'",
      ).get(tokenSha256, row.sessionId, row.issuerDeviceId);
      if (!issuer || issuer.householdId !== row.householdId ||
        !verifyCsrfToken(csrfToken, issuer.sessionId, issuer.csrfSecret))
        throw new ManagedScopeEnvelopeBackfillIssueDenied();
      const scope = db.prepare<[
        string, string, string, string, number, string, string, number
      ], BackfillScopeRow>(
        "SELECT recipient.encryption_public_key AS recipientPublicKey, " +
        "k.key_commitment AS keyCommitment, " +
        "historical.sequence AS historicalActivationSequence, " +
        "historical.event_sha256 AS historicalActivationSha256, " +
        "current_key.sequence AS currentActiveKeySequence, " +
        "current_key.epoch AS currentActiveKeyEpoch, " +
        "current_key.head_sha256 AS currentActiveKeyHeadSha256, " +
        "g.sequence AS currentGrantSequence, " +
        "g.head_sha256 AS currentGrantHeadSha256 " +
        "FROM managed_scopes sc " +
        "JOIN managed_profiles p ON p.household_id = sc.household_id " +
        "AND p.id = sc.profile_id " +
        "JOIN managed_key_identities k ON k.household_id = sc.household_id " +
        "AND k.profile_id = sc.profile_id AND k.scope_id = sc.id " +
        "JOIN managed_active_key_events historical " +
        "ON historical.household_id = sc.household_id " +
        "AND historical.profile_id = sc.profile_id " +
        "AND historical.scope_id = sc.id " +
        "AND historical.key_id = k.key_id AND historical.epoch = k.epoch " +
        "JOIN managed_current_scope_keys current_key " +
        "ON current_key.household_id = sc.household_id " +
        "AND current_key.profile_id = sc.profile_id " +
        "AND current_key.scope_id = sc.id " +
        "JOIN managed_grant_heads g ON g.household_id = sc.household_id " +
        "AND g.profile_id = sc.profile_id AND g.scope_id = sc.id " +
        "JOIN managed_grant_events grant_event " +
        "ON grant_event.household_id = g.household_id " +
        "AND grant_event.profile_id = g.profile_id " +
        "AND grant_event.scope_id = g.scope_id " +
        "AND grant_event.subject_device_id = g.subject_device_id " +
        "AND grant_event.sequence = g.sequence " +
        "JOIN managed_devices recipient ON recipient.household_id = g.household_id " +
        "AND recipient.id = g.subject_device_id " +
        "JOIN managed_memberships recipient_member " +
        "ON recipient_member.household_id = recipient.household_id " +
        "AND recipient_member.account_id = recipient.account_id " +
        "JOIN managed_accounts recipient_account " +
        "ON recipient_account.id = recipient_member.account_id " +
        "WHERE sc.household_id = ? AND sc.profile_id = ? AND sc.id = ? " +
        "AND k.key_id = ? AND k.epoch = ? AND k.purpose = ? " +
        "AND recipient.id = ? AND historical.sequence = ? " +
        "AND sc.kind = k.purpose AND historical.purpose = k.purpose " +
        "AND historical.key_commitment = k.key_commitment " +
        "AND historical.sequence < current_key.sequence " +
        "AND k.epoch < current_key.epoch " +
        "AND sc.state = 'active' AND p.state = 'active' " +
        "AND recipient.state = 'active' " +
        "AND recipient_member.state = 'active' " +
        "AND recipient_account.state = 'active' " +
        "AND recipient_account.email_verified_at IS NOT NULL " +
        "AND g.head_sha256 = grant_event.event_sha256 " +
        "AND (g.capability_mask & 1) = 1 " +
        "AND (grant_event.capability_mask & 1) = 1",
      ).get(row.householdId, row.careProfileId, row.opaqueScopeId,
        row.keyId, row.keyEpoch, row.purpose, row.recipientDeviceId,
        Number(row.historicalActivationSequence));
      if (!scope || scope.keyCommitment.toString("hex") !==
        row.keyCommitmentSha256 ||
        ![scope.historicalActivationSequence, scope.currentActiveKeySequence,
          scope.currentActiveKeyEpoch, scope.currentGrantSequence]
          .every(Number.isSafeInteger))
        throw new ManagedScopeEnvelopeBackfillIssueDenied();
      const prior = db.prepare<[string, string], PriorRow>(
        "SELECT counter, action_sha256 AS actionSha256 " +
        "FROM managed_signed_actions WHERE household_id = ? AND device_id = ? " +
        "ORDER BY counter DESC LIMIT 1",
      ).get(row.householdId, row.issuerDeviceId);
      if (prior && (!Number.isSafeInteger(prior.counter) ||
        prior.counter < 1 || prior.counter >= Number.MAX_SAFE_INTEGER))
        throw new ManagedScopeEnvelopeBackfillIssueDenied();
      const expectedCounter = prior ? BigInt(prior.counter) + 1n : 1n;
      const expectedPrevious = prior?.actionSha256.toString("hex") ?? null;
      if (row.issuerCounter !== expectedCounter ||
        action.counter !== expectedCounter)
        throw new ManagedScopeEnvelopeBackfillIssueDenied();
      const now = db.prepare<[], { now: number }>(
        "SELECT unixepoch('now') AS now").get()?.now;
      if (!Number.isSafeInteger(now) ||
        row.createdAt < BigInt(now! - 5) ||
        row.createdAt > BigInt(now! + 5))
        throw new ManagedScopeEnvelopeBackfillIssueDenied();
      verifyScopeEnvelopeBackfill({ row, action,
        enrolledIssuerSigningPublicKey: issuer.signingPublicKey,
        enrolledRecipientEncryptionPublicKey: scope.recipientPublicKey,
        historicalActivationSequence: BigInt(scope.historicalActivationSequence),
        historicalActivationSha256:
          scope.historicalActivationSha256.toString("hex"),
        currentActiveKeySequence: BigInt(scope.currentActiveKeySequence),
        currentActiveKeyEpoch: scope.currentActiveKeyEpoch,
        currentActiveKeyHeadSha256:
          scope.currentActiveKeyHeadSha256.toString("hex"),
        currentGrantSequence: BigInt(scope.currentGrantSequence),
        currentGrantHeadSha256: scope.currentGrantHeadSha256.toString("hex"),
        expectedPreviousActionSha256: expectedPrevious,
        authenticatedSessionId: issuer.sessionId,
        authenticatedIssuerDeviceId: issuer.authenticatedDeviceId });
      db.prepare("INSERT INTO managed_signed_actions " +
        "(household_id, device_id, counter, action_kind, payload_sha256, " +
        "previous_action_sha256, action_sha256, signature, created_at) " +
        "VALUES (@householdId, @deviceId, @counter, 'envelope', @payloadSha256, " +
        "@previousActionSha256, @actionSha256, @signature, @createdAt)").run({
        householdId: row.householdId, deviceId: row.issuerDeviceId,
        counter: Number(row.issuerCounter),
        payloadSha256: Buffer.from(action.payloadSha256, "hex"),
        previousActionSha256: action.previousActionSha256 === null ? null :
          Buffer.from(action.previousActionSha256, "hex"),
        actionSha256: Buffer.from(action.actionSha256, "hex"),
        signature: Buffer.from(action.signature),
        createdAt: Number(row.createdAt),
      });
      db.prepare("INSERT INTO managed_scope_envelope_backfills_v2 " +
        "(household_id, profile_id, scope_id, key_id, epoch, purpose, " +
        "recipient_device_id, key_commitment, recipient_key_sha256, " +
        "wire_version, wire, wire_sha256, historical_activation_sequence, " +
        "historical_activation_sha256, current_active_key_sequence, " +
        "current_active_key_head_sha256, current_grant_sequence, " +
        "current_grant_head_sha256, signed_payload_sha256, issuer_device_id, " +
        "issuer_counter, session_id, created_at) VALUES " +
        "(@householdId, @profileId, @scopeId, @keyId, @epoch, @purpose, " +
        "@recipientDeviceId, @keyCommitment, @recipientKeySha256, 2, @wire, " +
        "@wireSha256, @historicalActivationSequence, @historicalActivationSha256, " +
        "@currentActiveKeySequence, @currentActiveKeyHeadSha256, " +
        "@currentGrantSequence, @currentGrantHeadSha256, @signedPayloadSha256, " +
        "@issuerDeviceId, @issuerCounter, @sessionId, @createdAt)").run({
        householdId: row.householdId, profileId: row.careProfileId,
        scopeId: row.opaqueScopeId, keyId: row.keyId, epoch: row.keyEpoch,
        purpose: row.purpose, recipientDeviceId: row.recipientDeviceId,
        keyCommitment: Buffer.from(row.keyCommitmentSha256, "hex"),
        recipientKeySha256: Buffer.from(row.recipientKeySha256, "hex"),
        wire: Buffer.from(row.wire),
        wireSha256: Buffer.from(row.wireSha256, "hex"),
        historicalActivationSequence: Number(row.historicalActivationSequence),
        historicalActivationSha256:
          Buffer.from(row.historicalActivationSha256, "hex"),
        currentActiveKeySequence: Number(row.currentActiveKeySequence),
        currentActiveKeyHeadSha256:
          Buffer.from(row.currentActiveKeyHeadSha256, "hex"),
        currentGrantSequence: Number(row.currentGrantSequence),
        currentGrantHeadSha256:
          Buffer.from(row.currentGrantHeadSha256, "hex"),
        signedPayloadSha256: Buffer.from(row.signedPayloadSha256, "hex"),
        issuerDeviceId: row.issuerDeviceId,
        issuerCounter: Number(row.issuerCounter), sessionId: row.sessionId,
        createdAt: Number(row.createdAt),
      });
    });
    issue.immediate();
  } catch { throw new ManagedScopeEnvelopeBackfillIssueDenied(); }
}

function safePositiveSqlInteger(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" || value.byteLength !== length)
    throw new ManagedScopeEnvelopeBackfillIssueDenied();
  return Uint8Array.from(value);
}
