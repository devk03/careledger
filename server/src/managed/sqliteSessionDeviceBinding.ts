import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import Database from "better-sqlite3";
import { encodeSessionDeviceChallengeWireV1,
  parseSessionDeviceProofWireV1,
  type SessionDeviceChallengeWireV1 } from "@adeno/contracts";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";
import { verifySessionDeviceBindingProof } from
  "./verifySessionDeviceBindingProof.js";

const ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_CHALLENGES_PER_SESSION = 16;

type IssueRow = { householdId: string; accountId: string;
  sessionId: string; deviceId: string; csrfSecret: Buffer;
  sessionExpiresAt: number };
type BindRow = { householdId: string; accountId: string;
  sessionId: string; deviceId: string; challengeId: string;
  nonceSha256: Buffer; audienceSha256: Buffer;
  expiresAt: number; csrfSecret: Buffer; signingPublicKey: Buffer };

export class ManagedSessionDeviceBindingDenied extends Error {
  constructor() {
    super("This device could not be connected to the session.");
    this.name = "ManagedSessionDeviceBindingDenied";
  }
}

/**
 * UNMOUNTED managed-v9 candidate. The caller supplies an already opened,
 * private managed connection and a deployment-configured origin, never a
 * request Host/Origin value. tokenSha256 must come from the HttpOnly cookie;
 * the mounted route must also enforce a trusted Origin/CORS policy and rate
 * limits. This service does not enroll keys or prove human approval.
 */
export class SqliteSessionDeviceBindingCandidate {
  private readonly audienceSha256: Buffer;

  constructor(private readonly db: Database.Database, configuredOrigin: string) {
    try {
      const origin = new URL(configuredOrigin);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if (origin.origin !== configuredOrigin ||
        (origin.protocol !== "https:" &&
          !(origin.protocol === "http:" && local)))
        throw new ManagedSessionDeviceBindingDenied();
      this.audienceSha256 = sha256(Buffer.from(configuredOrigin, "utf8"));
      assertManagedSchema(db);
    } catch { throw new ManagedSessionDeviceBindingDenied(); }
  }

  /** Content-free JSON-safe challenge; no family key or medical metadata. */
  issueWire(input: { tokenSha256: string; csrfToken: string;
    deviceId: string }): SessionDeviceChallengeWireV1 {
    try { return encodeSessionDeviceChallengeWireV1(this.issueRaw(input)); }
    catch { throw new ManagedSessionDeviceBindingDenied(); }
  }

  /** Accept only the exact, bounded JSON proof object. */
  bindWire(input: { tokenSha256: string; csrfToken: string;
    proof: unknown }): void {
    try {
      const proof = parseSessionDeviceProofWireV1(input.proof);
      this.bindRaw({ tokenSha256: input.tokenSha256,
        csrfToken: input.csrfToken, ...proof });
    } catch { throw new ManagedSessionDeviceBindingDenied(); }
  }

  private issueRaw(input: { tokenSha256: string; csrfToken: string;
    deviceId: string }): {
    householdId: string; accountId: string; sessionId: string;
    deviceId: string; challengeId: string; nonce: Uint8Array;
    expiresAt: bigint;
  } {
    try {
      checkSessionInput(input.tokenSha256, input.csrfToken);
      if (!ID.test(input.deviceId)) throw new ManagedSessionDeviceBindingDenied();
      const token = Buffer.from(input.tokenSha256, "hex");
      const issue = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const row = this.db.prepare<[Buffer, string], IssueRow>(
          "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
          "s.id AS sessionId, d.id AS deviceId, s.csrf_secret AS csrfSecret, " +
          "s.expires_at AS sessionExpiresAt " +
          "FROM managed_sessions s " +
          "JOIN managed_accounts a ON a.id = s.account_id " +
          "JOIN managed_memberships m ON m.household_id = s.household_id " +
          "AND m.account_id = s.account_id " +
          "JOIN managed_families f ON f.id = s.household_id " +
          "JOIN managed_devices d ON d.household_id = s.household_id " +
          "AND d.account_id = s.account_id " +
          "WHERE s.token_sha256 = ? AND d.id = ? " +
          "AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now') " +
          "AND s.account_auth_version = a.auth_version " +
          "AND s.membership_auth_version = m.auth_version " +
          "AND a.state = 'active' AND m.state = 'active' " +
          "AND f.state = 'active' AND d.state = 'active' " +
          "AND NOT EXISTS (SELECT 1 FROM managed_session_device_bindings b " +
          "WHERE b.household_id = s.household_id AND b.session_id = s.id)",
        ).get(token, input.deviceId);
        if (!row || !verifyCsrfToken(input.csrfToken, row.sessionId,
          row.csrfSecret)) throw new ManagedSessionDeviceBindingDenied();
        const now = databaseNow(this.db);
        const expiresAt = Math.min(now + 300, row.sessionExpiresAt);
        if (expiresAt <= now) throw new ManagedSessionDeviceBindingDenied();
        const attempts = this.db.prepare<[string, string], { count: number }>(
          "SELECT COUNT(*) AS count FROM managed_session_device_challenges " +
          "WHERE household_id = ? AND session_id = ?",
        ).get(row.householdId, row.sessionId)?.count;
        if (!Number.isSafeInteger(attempts) ||
          attempts! >= MAX_CHALLENGES_PER_SESSION)
          throw new ManagedSessionDeviceBindingDenied();
        const challengeId = randomBytes(16).toString("hex");
        const nonce = randomBytes(32);
        this.db.prepare(
          "INSERT INTO managed_session_device_challenges " +
          "(household_id, id, account_id, session_id, device_id, " +
          "nonce_sha256, audience_sha256, created_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(row.householdId, challengeId, row.accountId, row.sessionId,
          row.deviceId, sha256(nonce), this.audienceSha256, now, expiresAt);
        return { householdId: row.householdId, accountId: row.accountId,
          sessionId: row.sessionId, deviceId: row.deviceId, challengeId,
          nonce: Uint8Array.from(nonce), expiresAt: BigInt(expiresAt) };
      });
      return issue.immediate();
    } catch { throw new ManagedSessionDeviceBindingDenied(); }
  }

  /** One transaction rechecks the live account/device/session, verifies the
   * enrolled key's signature, consumes once, and inserts one immutable binding. */
  private bindRaw(input: { tokenSha256: string; csrfToken: string;
    challengeId: string; nonce: Uint8Array; signature: Uint8Array }): void {
    try {
      checkSessionInput(input.tokenSha256, input.csrfToken);
      if (!ID.test(input.challengeId))
        throw new ManagedSessionDeviceBindingDenied();
      const nonce = copyBytes(input.nonce, 32);
      const signature = copyBytes(input.signature, 64);
      const token = Buffer.from(input.tokenSha256, "hex");
      assertManagedSchema(this.db);
      const preflight = this.loadBindRow(token, input.challengeId);
      this.checkBindRow(preflight, input.csrfToken, nonce);
      verifySessionDeviceBindingProof({ context: {
        householdId: preflight.householdId,
        accountId: preflight.accountId, sessionId: preflight.sessionId,
        deviceId: preflight.deviceId, challengeId: preflight.challengeId,
        nonceSha256: preflight.nonceSha256.toString("hex"),
        audienceSha256: preflight.audienceSha256.toString("hex"),
        expiresAt: BigInt(preflight.expiresAt),
      }, enrolledSigningPublicKey: preflight.signingPublicKey, signature });
      const bind = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const row = this.loadBindRow(token, input.challengeId);
        this.checkBindRow(row, input.csrfToken, nonce);
        if (!sameBindRow(preflight, row))
          throw new ManagedSessionDeviceBindingDenied();
        const now = databaseNow(this.db);
        const consumed = this.db.prepare<[
          number, Buffer, string, string
        ]>(
          "UPDATE managed_session_device_challenges " +
          "SET consumed_at = ?, proof_signature = ? " +
          "WHERE household_id = ? AND id = ? AND consumed_at IS NULL " +
          "AND expires_at > unixepoch('now')",
        ).run(now, Buffer.from(signature), row.householdId, row.challengeId);
        if (consumed.changes !== 1)
          throw new ManagedSessionDeviceBindingDenied();
        this.db.prepare(
          "INSERT INTO managed_session_device_bindings " +
          "(household_id, session_id, account_id, device_id, " +
          "challenge_id, bound_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(row.householdId, row.sessionId, row.accountId, row.deviceId,
          row.challengeId, now);
      });
      bind.immediate();
    } catch { throw new ManagedSessionDeviceBindingDenied(); }
  }

  private loadBindRow(token: Buffer, challengeId: string): BindRow | undefined {
    return this.db.prepare<[Buffer, string], BindRow>(
      "SELECT c.household_id AS householdId, c.account_id AS accountId, " +
      "c.session_id AS sessionId, c.device_id AS deviceId, " +
      "c.id AS challengeId, c.nonce_sha256 AS nonceSha256, " +
      "c.audience_sha256 AS audienceSha256, c.expires_at AS expiresAt, " +
      "s.csrf_secret AS csrfSecret, " +
      "d.signing_public_key AS signingPublicKey " +
      "FROM managed_session_device_challenges c " +
      "JOIN managed_sessions s ON s.household_id = c.household_id " +
      "AND s.account_id = c.account_id AND s.id = c.session_id " +
      "JOIN managed_accounts a ON a.id = s.account_id " +
      "JOIN managed_memberships m ON m.household_id = s.household_id " +
      "AND m.account_id = s.account_id " +
      "JOIN managed_families f ON f.id = s.household_id " +
      "JOIN managed_devices d ON d.household_id = c.household_id " +
      "AND d.account_id = c.account_id AND d.id = c.device_id " +
      "WHERE s.token_sha256 = ? AND c.id = ? " +
      "AND c.consumed_at IS NULL AND c.expires_at > unixepoch('now') " +
      "AND s.revoked_at IS NULL AND s.expires_at > unixepoch('now') " +
      "AND s.account_auth_version = a.auth_version " +
      "AND s.membership_auth_version = m.auth_version " +
      "AND a.state = 'active' AND m.state = 'active' " +
      "AND f.state = 'active' AND d.state = 'active' " +
      "AND NOT EXISTS (SELECT 1 FROM managed_session_device_bindings b " +
      "WHERE b.household_id = s.household_id AND b.session_id = s.id)",
    ).get(token, challengeId);
  }

  private checkBindRow(row: BindRow | undefined, csrfToken: string,
    nonce: Uint8Array): asserts row is BindRow {
    if (!row || !verifyCsrfToken(csrfToken, row.sessionId,
      row.csrfSecret) || !equalDigest(sha256(nonce), row.nonceSha256) ||
      !equalDigest(this.audienceSha256, row.audienceSha256) ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt <= databaseNow(this.db))
      throw new ManagedSessionDeviceBindingDenied();
  }
}

function sameBindRow(left: BindRow, right: BindRow): boolean {
  return left.householdId === right.householdId &&
    left.accountId === right.accountId &&
    left.sessionId === right.sessionId &&
    left.deviceId === right.deviceId &&
    left.challengeId === right.challengeId &&
    left.expiresAt === right.expiresAt &&
    equalDigest(left.nonceSha256, right.nonceSha256) &&
    equalDigest(left.audienceSha256, right.audienceSha256) &&
    equalDigest(left.signingPublicKey, right.signingPublicKey) &&
    equalDigest(left.csrfSecret, right.csrfSecret);
}

function checkSessionInput(tokenSha256: string, csrfToken: string): void {
  if (typeof tokenSha256 !== "string" || !SHA256.test(tokenSha256) ||
    typeof csrfToken !== "string" || csrfToken.length > 256)
    throw new ManagedSessionDeviceBindingDenied();
}

function databaseNow(db: Database.Database): number {
  const now = db.prepare<[], { now: number }>(
    "SELECT unixepoch('now') AS now").get()?.now;
  if (!Number.isSafeInteger(now) || now! < 1)
    throw new ManagedSessionDeviceBindingDenied();
  return now!;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return Buffer.isBuffer(right) && right.byteLength === 32 &&
    timingSafeEqual(left, right);
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new ManagedSessionDeviceBindingDenied();
  return Uint8Array.from(value);
}
