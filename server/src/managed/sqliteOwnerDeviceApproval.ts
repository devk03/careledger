import { createHash, timingSafeEqual } from "node:crypto";

import { verify } from "@node-rs/argon2";
import { encodeDeviceApprovalCodeMaterialV1, formatDeviceApprovalCodeV1,
  isDeviceApprovalCodeV1 } from "@adeno/contracts";
import Database from "better-sqlite3";

import { verifyCsrfToken, type MutationPreflight } from
  "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";

const ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

type ApprovedPreflight = Extract<MutationPreflight, { ok: true }>;
type OwnerSession = { householdId: string; accountId: string;
  sessionId: string; csrfSecret: Buffer; passwordHash: string;
  accountVersion: number; membershipVersion: number };
type PendingDevice = { householdId: string; accountId: string;
  deviceId: string; encryptionPublicKey: Buffer; signingPublicKey: Buffer };

export class ManagedOwnerDeviceApprovalDenied extends Error {
  constructor() {
    super("This device could not be approved.");
    this.name = "ManagedOwnerDeviceApprovalDenied";
  }
}

/**
 * UNMOUNTED v10 candidate: owner reauth plus a code manually compared with
 * the candidate device. V10 records only activation time, not approver; this
 * is not a durable human-approval audit. Enrollment and its original session
 * must still be live (the challenge lasts at most ten minutes).
 */
export class SqliteOwnerDeviceApprovalCandidate {
  private activePasswordOperations = 0;

  constructor(private readonly db: Database.Database) {
    assertManagedSchema(db);
  }

  /** Caller must first enforce configured Origin via cookie preflight. */
  async approve(input: ApprovedPreflight & { deviceId: string;
    password: string; comparisonCode: string }):
    Promise<{ deviceId: string; state: "active" }> {
    try {
      if (!input || input.ok !== true ||
        typeof input.tokenSha256 !== "string" ||
        !SHA256.test(input.tokenSha256) ||
        typeof input.csrfToken !== "string" ||
        input.csrfToken.length > 256 ||
        typeof input.deviceId !== "string" || !ID.test(input.deviceId) ||
        typeof input.password !== "string" || input.password.length < 12 ||
        input.password.length > 128 || input.password.includes("\0") ||
        Buffer.byteLength(input.password, "utf8") > 512 ||
        !isDeviceApprovalCodeV1(input.comparisonCode))
        throw new ManagedOwnerDeviceApprovalDenied();
      assertManagedSchema(this.db);
      const token = Buffer.from(input.tokenSha256, "hex");
      const owner = this.loadOwner(token);
      if (!owner || !verifyCsrfToken(input.csrfToken, owner.sessionId,
        owner.csrfSecret)) throw new ManagedOwnerDeviceApprovalDenied();
      let passwordMatches = false;
      try { passwordMatches = await this.passwordOperation(() =>
        verify(owner.passwordHash, input.password)); }
      catch { /* Generic denial; never return the password/hash. */ }
      if (!passwordMatches) throw new ManagedOwnerDeviceApprovalDenied();
      const approve = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const current = this.loadOwner(token);
        if (!current || !sameOwner(owner, current) ||
          !verifyCsrfToken(input.csrfToken, current.sessionId,
            current.csrfSecret)) throw new ManagedOwnerDeviceApprovalDenied();
        const pending = this.loadPending(current.householdId, input.deviceId);
        if (!pending) throw new ManagedOwnerDeviceApprovalDenied();
        const material = encodeDeviceApprovalCodeMaterialV1({
          householdId: pending.householdId, accountId: pending.accountId,
          deviceId: pending.deviceId,
          encryptionPublicKey: pending.encryptionPublicKey,
          signingPublicKey: pending.signingPublicKey,
        });
        const expected = formatDeviceApprovalCodeV1(
          createHash("sha256").update(material).digest());
        if (!timingSafeEqual(Buffer.from(expected, "ascii"),
          Buffer.from(input.comparisonCode.toLowerCase(), "ascii")))
          throw new ManagedOwnerDeviceApprovalDenied();
        const now = databaseNow(this.db);
        const changed = this.db.prepare("UPDATE managed_devices " +
          "SET state='active', activated_at=? " +
          "WHERE household_id=? AND id=? AND state='pending' " +
          "AND encryption_public_key=? AND signing_public_key=?")
          .run(now, current.householdId, pending.deviceId,
            pending.encryptionPublicKey, pending.signingPublicKey);
        if (changed.changes !== 1) throw new ManagedOwnerDeviceApprovalDenied();
      });
      approve.immediate();
      return { deviceId: input.deviceId, state: "active" };
    } catch { throw new ManagedOwnerDeviceApprovalDenied(); }
  }

  private loadOwner(token: Buffer): OwnerSession | undefined {
    return this.db.prepare<[Buffer], OwnerSession>(
      "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
      "s.id AS sessionId, s.csrf_secret AS csrfSecret, " +
      "a.password_hash AS passwordHash, a.auth_version AS accountVersion, " +
      "m.auth_version AS membershipVersion FROM managed_sessions s " +
      "JOIN managed_accounts a ON a.id=s.account_id " +
      "JOIN managed_memberships m ON m.household_id=s.household_id " +
      "AND m.account_id=s.account_id " +
      "JOIN managed_families f ON f.id=s.household_id " +
      "WHERE s.token_sha256=? AND s.revoked_at IS NULL " +
      "AND s.expires_at>unixepoch('now') " +
      "AND s.account_auth_version=a.auth_version " +
      "AND s.membership_auth_version=m.auth_version " +
      "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state='active' AND m.role='owner' " +
      "AND m.member_kind='adult' AND f.state='active'",
    ).get(token);
  }

  private loadPending(householdId: string, deviceId: string):
    PendingDevice | undefined {
    return this.db.prepare<[string, string], PendingDevice>(
      "SELECT d.household_id AS householdId, d.account_id AS accountId, " +
      "d.id AS deviceId, d.encryption_public_key AS encryptionPublicKey, " +
      "d.signing_public_key AS signingPublicKey " +
      "FROM managed_devices d " +
      "JOIN managed_enrollment_challenges c " +
      "ON c.household_id=d.household_id " +
      "AND c.id=d.enrollment_challenge_id AND c.account_id=d.account_id " +
      "JOIN managed_sessions s ON s.household_id=c.household_id " +
      "AND s.id=c.session_id AND s.account_id=c.account_id " +
      "JOIN managed_accounts a ON a.id=d.account_id " +
      "JOIN managed_memberships m ON m.household_id=d.household_id " +
      "AND m.account_id=d.account_id " +
      "JOIN managed_families f ON f.id=d.household_id " +
      "WHERE d.household_id=? AND d.id=? AND d.state='pending' " +
      "AND c.consumed_at IS NOT NULL AND c.proof_signature IS NOT NULL " +
      "AND c.expires_at>unixepoch('now') " +
      "AND c.encryption_public_key=d.encryption_public_key " +
      "AND c.signing_public_key=d.signing_public_key " +
      "AND s.revoked_at IS NULL AND s.expires_at>unixepoch('now') " +
      "AND s.account_auth_version=a.auth_version " +
      "AND s.membership_auth_version=m.auth_version " +
      "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state='active' AND f.state='active'",
    ).get(householdId, deviceId);
  }

  /** Process-local Argon2 backstop; a shared ingress limiter is still needed. */
  private async passwordOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.activePasswordOperations >= 4)
      throw new ManagedOwnerDeviceApprovalDenied();
    this.activePasswordOperations += 1;
    try { return await work(); }
    finally { this.activePasswordOperations -= 1; }
  }
}

function sameOwner(a: OwnerSession, b: OwnerSession): boolean {
  return a.householdId === b.householdId && a.accountId === b.accountId &&
    a.sessionId === b.sessionId && a.passwordHash === b.passwordHash &&
    a.accountVersion === b.accountVersion &&
    a.membershipVersion === b.membershipVersion &&
    a.csrfSecret.equals(b.csrfSecret);
}

function databaseNow(db: Database.Database): number {
  const now = db.prepare<[], { now: number }>(
    "SELECT unixepoch('now') AS now").get()?.now;
  if (!Number.isSafeInteger(now) || now! < 1)
    throw new ManagedOwnerDeviceApprovalDenied();
  return now!;
}
