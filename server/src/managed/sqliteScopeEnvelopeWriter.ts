import Database from "better-sqlite3";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";
import { verifyScopeEnvelopeAction,
  type ScopeEnvelopeRowCandidate,
  type SignedScopeEnvelopeActionRow } from "./verifyScopeEnvelopeAction.js";

const SHA256 = /^[0-9a-f]{64}$/u;
const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;

type IssuerRow = { householdId: string; sessionId: string;
  csrfSecret: Buffer; signingPublicKey: Buffer };
type ScopeRow = { recipientPublicKey: Buffer; keyCommitment: Buffer;
  activeKeyHead: Buffer; grantHead: Buffer };
type PriorRow = { counter: number; actionSha256: Buffer };

export class ManagedScopeEnvelopeIssueDenied extends Error {
  constructor() {
    super("The encrypted scope-key envelope could not be issued.");
    this.name = "ManagedScopeEnvelopeIssueDenied";
  }
}

/**
 * Unmounted managed-v8 writer. Pass only an already opened private managed SQLite
 * connection. This does not open/create databases, run migrations, expose a
 * route, prove recipient HPKE decryptability, or authorize later reads.
 * A mounted caller must authenticate the request and bound its size before
 * invoking this function; no user-controlled SQL identifiers are accepted.
 */
export function issueScopeEnvelopeV2(db: Database.Database, input: {
  tokenSha256: string;
  csrfToken: string;
  row: ScopeEnvelopeRowCandidate;
  action: SignedScopeEnvelopeActionRow;
}): void {
  try {
    if (typeof input.tokenSha256 !== "string" ||
      !SHA256.test(input.tokenSha256) ||
      typeof input.csrfToken !== "string" || input.csrfToken.length > 256 ||
      typeof input.row.issuerCounter !== "bigint" ||
      typeof input.row.createdAt !== "bigint" ||
      !Number.isSafeInteger(Number(input.row.issuerCounter)) ||
      !Number.isSafeInteger(Number(input.row.createdAt)) ||
      input.row.issuerCounter < 1n || input.row.createdAt < 1n)
      throw new ManagedScopeEnvelopeIssueDenied();
    const row = { ...input.row, wire: copyBytes(input.row.wire, 240) };
    const action = { ...input.action,
      signature: copyBytes(input.action.signature, 64) };
    const tokenSha256 = Buffer.from(input.tokenSha256, "hex");
    const csrfToken = input.csrfToken;
    const issue = db.transaction(() => {
      assertManagedSchema(db);
      const issuer = db.prepare<[Buffer, string, string], IssuerRow>(
        "SELECT s.household_id AS householdId, s.id AS sessionId, " +
        "s.csrf_secret AS csrfSecret, d.signing_public_key AS signingPublicKey " +
        "FROM managed_sessions s " +
        "JOIN managed_accounts a ON a.id = s.account_id " +
        "JOIN managed_memberships m ON m.household_id = s.household_id " +
        "AND m.account_id = s.account_id " +
        "JOIN managed_families f ON f.id = s.household_id " +
        "JOIN managed_devices d ON d.household_id = s.household_id " +
        "AND d.account_id = s.account_id " +
        "WHERE s.token_sha256 = ? AND s.id = ? AND d.id = ? " +
        "AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now') " +
        "AND s.account_auth_version = a.auth_version " +
        "AND s.membership_auth_version = m.auth_version " +
        "AND a.state = 'active' AND m.state = 'active' AND m.role = 'owner' " +
        "AND f.state = 'active' AND d.state = 'active'",
      ).get(tokenSha256, row.sessionId, row.issuerDeviceId);
      if (!issuer || issuer.householdId !== row.householdId ||
        !verifyCsrfToken(csrfToken, issuer.sessionId, issuer.csrfSecret))
        throw new ManagedScopeEnvelopeIssueDenied();
      const scope = db.prepare<[
        string, string, string, string, number, string, string
      ], ScopeRow>(
        "SELECT recipient.encryption_public_key AS recipientPublicKey, " +
        "k.key_commitment AS keyCommitment, " +
        "current_key.head_sha256 AS activeKeyHead, " +
        "g.head_sha256 AS grantHead " +
        "FROM managed_scopes sc " +
        "JOIN managed_profiles p ON p.household_id = sc.household_id " +
        "AND p.id = sc.profile_id " +
        "JOIN managed_current_scope_keys current_key " +
        "ON current_key.household_id = sc.household_id " +
        "AND current_key.profile_id = sc.profile_id " +
        "AND current_key.scope_id = sc.id " +
        "JOIN managed_key_identities k ON k.household_id = sc.household_id " +
        "AND k.profile_id = sc.profile_id AND k.scope_id = sc.id " +
        "AND k.key_id = current_key.key_id AND k.epoch = current_key.epoch " +
        "JOIN managed_grant_heads g ON g.household_id = sc.household_id " +
        "AND g.profile_id = sc.profile_id AND g.scope_id = sc.id " +
        "JOIN managed_devices recipient ON recipient.household_id = g.household_id " +
        "AND recipient.id = g.subject_device_id " +
        "JOIN managed_memberships recipient_member " +
        "ON recipient_member.household_id = recipient.household_id " +
        "AND recipient_member.account_id = recipient.account_id " +
        "JOIN managed_accounts recipient_account " +
        "ON recipient_account.id = recipient_member.account_id " +
        "WHERE sc.household_id = ? AND sc.profile_id = ? AND sc.id = ? " +
        "AND k.key_id = ? AND k.epoch = ? AND k.purpose = ? " +
        "AND recipient.id = ? AND sc.kind = k.purpose " +
        "AND sc.state = 'active' AND p.state = 'active' " +
        "AND recipient.state = 'active' " +
        "AND recipient_member.state = 'active' " +
        "AND recipient_account.state = 'active' " +
        "AND (g.capability_mask & 1) = 1 AND g.head_sha256 IS NOT NULL",
      ).get(row.householdId, row.careProfileId, row.opaqueScopeId,
        row.keyId, row.keyEpoch, row.purpose, row.recipientDeviceId);
      if (!scope || scope.keyCommitment.toString("hex") !==
        row.keyCommitmentSha256)
        throw new ManagedScopeEnvelopeIssueDenied();
      const prior = db.prepare<[string, string], PriorRow>(
        "SELECT counter, action_sha256 AS actionSha256 " +
        "FROM managed_signed_actions WHERE household_id = ? AND device_id = ? " +
        "ORDER BY counter DESC LIMIT 1",
      ).get(row.householdId, row.issuerDeviceId);
      if (prior && (!Number.isSafeInteger(prior.counter) ||
        prior.counter < 1 || prior.counter >= Number.MAX_SAFE_INTEGER))
        throw new ManagedScopeEnvelopeIssueDenied();
      const expectedCounter = prior ? BigInt(prior.counter) + 1n : 1n;
      const expectedPrevious = prior?.actionSha256.toString("hex") ?? null;
      if (row.issuerCounter !== expectedCounter ||
        action.counter !== expectedCounter)
        throw new ManagedScopeEnvelopeIssueDenied();
      const now = db.prepare<[], { now: number }>(
        "SELECT unixepoch('now') AS now").get()?.now;
      if (!Number.isSafeInteger(now) ||
        row.createdAt < BigInt(now! - 5) ||
        row.createdAt > BigInt(now! + 5))
        throw new ManagedScopeEnvelopeIssueDenied();
      verifyScopeEnvelopeAction({ row, action,
        enrolledIssuerSigningPublicKey: issuer.signingPublicKey,
        enrolledRecipientEncryptionPublicKey: scope.recipientPublicKey,
        currentActiveKeyHeadSha256: scope.activeKeyHead.toString("hex"),
        currentGrantHeadSha256: scope.grantHead.toString("hex"),
        expectedPreviousActionSha256: expectedPrevious,
        authenticatedSessionId: issuer.sessionId,
        authenticatedIssuerDeviceId: row.issuerDeviceId });
      db.prepare(
        "INSERT INTO managed_signed_actions " +
        "(household_id, device_id, counter, action_kind, payload_sha256, " +
        "previous_action_sha256, action_sha256, signature, created_at) " +
        "VALUES (?, ?, ?, 'envelope', ?, ?, ?, ?, ?)",
      ).run(row.householdId, row.issuerDeviceId, Number(row.issuerCounter),
        Buffer.from(action.payloadSha256, "hex"),
        action.previousActionSha256 === null ? null :
          Buffer.from(action.previousActionSha256, "hex"),
        Buffer.from(action.actionSha256, "hex"), Buffer.from(action.signature),
        Number(row.createdAt));
      db.prepare(
        "INSERT INTO managed_scope_envelopes_v2 " +
        "(household_id, profile_id, scope_id, key_id, epoch, purpose, " +
        "recipient_device_id, key_commitment, recipient_key_sha256, " +
        "wire_version, wire, wire_sha256, active_key_head_sha256, " +
        "grant_head_sha256, signed_payload_sha256, issuer_device_id, " +
        "issuer_counter, session_id, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(row.householdId, row.careProfileId, row.opaqueScopeId,
        row.keyId, row.keyEpoch, row.purpose, row.recipientDeviceId,
        Buffer.from(row.keyCommitmentSha256, "hex"),
        Buffer.from(row.recipientKeySha256, "hex"), Buffer.from(row.wire),
        Buffer.from(row.wireSha256, "hex"),
        Buffer.from(row.activeKeyHeadSha256, "hex"),
        Buffer.from(row.grantHeadSha256, "hex"),
        Buffer.from(row.signedPayloadSha256, "hex"),
        row.issuerDeviceId, Number(row.issuerCounter), row.sessionId,
        Number(row.createdAt));
    });
    issue.immediate();
  } catch { throw new ManagedScopeEnvelopeIssueDenied(); }
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" || value.byteLength !== length)
    throw new ManagedScopeEnvelopeIssueDenied();
  return Uint8Array.from(value);
}
