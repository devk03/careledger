import { createHash, createPublicKey, diffieHellman, generateKeyPairSync,
  randomBytes, timingSafeEqual } from "node:crypto";

import Database from "better-sqlite3";
import { encodeDeviceEnrollmentChallengeWireV1,
  encodeDeviceEnrollmentNonceMaterialV1,
  parseDeviceEnrollmentProofWireV1,
  type DeviceEnrollmentChallengeWireV1 } from "@adeno/contracts";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";
import { verifyDeviceEnrollmentProof } from "./verifyDeviceEnrollmentProof.js";

const ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const MAX_CHALLENGES_PER_SESSION = 16;

type SessionRow = { householdId: string; accountId: string;
  sessionId: string; csrfSecret: Buffer; sessionExpiresAt: number };
type ChallengeRow = SessionRow & { challengeId: string;
  challengeSha256: Buffer; encryptionPublicKey: Buffer;
  signingPublicKey: Buffer; expiresAt: number };

export class ManagedDeviceEnrollmentDenied extends Error {
  constructor() {
    super("This device could not be prepared for enrollment.");
    this.name = "ManagedDeviceEnrollmentDenied";
  }
}

/**
 * UNMOUNTED managed-v10 candidate. The token digest must come only from the
 * HttpOnly cookie; the origin is trusted deployment configuration, never Host.
 * Completion verifies key possession and creates a PENDING device. It does
 * NOT approve/activate the device or prove a human's intent. A separately
 * designed, reauthenticated family approval path must activate it before
 * binding, grants, reads or writes. No managed route calls this yet.
 */
export class SqliteDeviceEnrollmentCandidate {
  private readonly audienceSha256: Buffer;

  constructor(private readonly db: Database.Database, configuredOrigin: string) {
    try {
      const origin = new URL(configuredOrigin);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
      if (origin.origin !== configuredOrigin ||
        (origin.protocol !== "https:" &&
          !(origin.protocol === "http:" && local)))
        throw new ManagedDeviceEnrollmentDenied();
      this.audienceSha256 = sha256(Buffer.from(configuredOrigin, "utf8"));
      assertManagedSchema(db);
    } catch { throw new ManagedDeviceEnrollmentDenied(); }
  }

  issueWire(input: { tokenSha256: string; csrfToken: string;
    encryptionPublicKeyHex: string; signingPublicKeyHex: string }):
    DeviceEnrollmentChallengeWireV1 {
    try {
      checkSessionInput(input.tokenSha256, input.csrfToken);
      const encryptionKey = keyFromHex(input.encryptionPublicKeyHex);
      const signingKey = keyFromHex(input.signingPublicKeyHex);
      const issue = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const session = this.loadSession(Buffer.from(input.tokenSha256, "hex"));
        if (!session || !verifyCsrfToken(input.csrfToken, session.sessionId,
          session.csrfSecret)) throw new ManagedDeviceEnrollmentDenied();
        const now = databaseNow(this.db);
        const expiresAt = Math.min(now + 600, session.sessionExpiresAt);
        if (expiresAt <= now) throw new ManagedDeviceEnrollmentDenied();
        const count = this.db.prepare<[string, string], { count: number }>(
          "SELECT COUNT(*) AS count FROM managed_enrollment_challenges " +
          "WHERE household_id=? AND session_id=?",
        ).get(session.householdId, session.sessionId)?.count;
        if (!Number.isSafeInteger(count) ||
          count! >= MAX_CHALLENGES_PER_SESSION)
          throw new ManagedDeviceEnrollmentDenied();
        const challengeId = randomBytes(16).toString("hex");
        const { ephemeralPublicKey, sharedSecret } =
          deriveX25519Secret(encryptionKey);
        const material = encodeDeviceEnrollmentNonceMaterialV1({
          sharedSecret, challengeId,
          audienceSha256: this.audienceSha256.toString("hex"),
        });
        const nonce = sha256(material);
        material.fill(0);
        sharedSecret.fill(0);
        const challengeHash = sha256(nonce);
        nonce.fill(0);
        this.db.prepare("INSERT INTO managed_enrollment_challenges " +
          "(household_id,id,account_id,session_id,challenge_sha256," +
          "encryption_public_key,signing_public_key,created_at,expires_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?)").run(session.householdId,
          challengeId, session.accountId, session.sessionId, challengeHash,
          encryptionKey, signingKey, now, expiresAt);
        return encodeDeviceEnrollmentChallengeWireV1({
          householdId: session.householdId, accountId: session.accountId,
          sessionId: session.sessionId, challengeId, ephemeralPublicKey,
          expiresAt: BigInt(expiresAt), encryptionPublicKey: encryptionKey,
          signingPublicKey: signingKey,
        });
      });
      return issue.immediate();
    } catch { throw new ManagedDeviceEnrollmentDenied(); }
  }

  /** Creates a pending device only; activation requires separate approval. */
  proveWire(input: { tokenSha256: string; csrfToken: string;
    proof: unknown }): { deviceId: string; state: "pending" } {
    try {
      checkSessionInput(input.tokenSha256, input.csrfToken);
      const proof = parseDeviceEnrollmentProofWireV1(input.proof);
      const token = Buffer.from(input.tokenSha256, "hex");
      assertManagedSchema(this.db);
      const preflight = this.loadChallenge(token, proof.challengeId);
      this.checkChallenge(preflight, input.csrfToken, proof.nonce);
      verifyDeviceEnrollmentProof({ context: {
        householdId: preflight.householdId, accountId: preflight.accountId,
        sessionId: preflight.sessionId, challengeId: preflight.challengeId,
        nonceSha256: preflight.challengeSha256.toString("hex"),
        audienceSha256: this.audienceSha256.toString("hex"),
        encryptionPublicKeyHex: preflight.encryptionPublicKey.toString("hex"),
        signingPublicKeyHex: preflight.signingPublicKey.toString("hex"),
        expiresAt: BigInt(preflight.expiresAt),
      }, proposedSigningPublicKey: preflight.signingPublicKey,
      signature: proof.signature });
      const prove = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const row = this.loadChallenge(token, proof.challengeId);
        this.checkChallenge(row, input.csrfToken, proof.nonce);
        if (!sameChallenge(preflight, row))
          throw new ManagedDeviceEnrollmentDenied();
        const now = databaseNow(this.db);
        // The v1 pending-device trigger requires an unconsumed challenge.
        // Inserting first and consuming second is safe in one transaction:
        // any failure rolls both back.
        this.db.prepare("INSERT INTO managed_devices " +
          "(household_id,id,account_id,enrollment_challenge_id,state," +
          "encryption_public_key,signing_public_key,created_at) " +
          "VALUES (?,?,?,?,'pending',?,?,?)")
          .run(row.householdId, row.challengeId, row.accountId,
            row.challengeId, row.encryptionPublicKey, row.signingPublicKey, now);
        const consumed = this.db.prepare("UPDATE managed_enrollment_challenges " +
          "SET consumed_at=?, proof_signature=? " +
          "WHERE household_id=? AND id=? AND consumed_at IS NULL " +
          "AND expires_at > unixepoch('now')")
          .run(now, Buffer.from(proof.signature), row.householdId,
            row.challengeId);
        if (consumed.changes !== 1) throw new ManagedDeviceEnrollmentDenied();
      });
      prove.immediate();
      return { deviceId: proof.challengeId, state: "pending" };
    } catch { throw new ManagedDeviceEnrollmentDenied(); }
  }

  private loadSession(token: Buffer): SessionRow | undefined {
    return this.db.prepare<[Buffer], SessionRow>(
      "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
      "s.id AS sessionId, s.csrf_secret AS csrfSecret, " +
      "s.expires_at AS sessionExpiresAt FROM managed_sessions s " +
      "JOIN managed_accounts a ON a.id=s.account_id " +
      "JOIN managed_memberships m ON m.household_id=s.household_id " +
      "AND m.account_id=s.account_id " +
      "JOIN managed_families f ON f.id=s.household_id " +
      "WHERE s.token_sha256=? AND s.revoked_at IS NULL " +
      "AND s.expires_at>unixepoch('now') " +
      "AND s.account_auth_version=a.auth_version " +
      "AND s.membership_auth_version=m.auth_version " +
      "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state='active' AND f.state='active'",
    ).get(token);
  }

  private loadChallenge(token: Buffer, challengeId: string):
    ChallengeRow | undefined {
    if (!ID.test(challengeId)) throw new ManagedDeviceEnrollmentDenied();
    return this.db.prepare<[Buffer, string], ChallengeRow>(
      "SELECT c.household_id AS householdId, c.account_id AS accountId, " +
      "c.session_id AS sessionId, c.id AS challengeId, " +
      "c.challenge_sha256 AS challengeSha256, " +
      "c.encryption_public_key AS encryptionPublicKey, " +
      "c.signing_public_key AS signingPublicKey, " +
      "c.expires_at AS expiresAt, s.csrf_secret AS csrfSecret, " +
      "s.expires_at AS sessionExpiresAt " +
      "FROM managed_enrollment_challenges c " +
      "JOIN managed_sessions s ON s.household_id=c.household_id " +
      "AND s.account_id=c.account_id AND s.id=c.session_id " +
      "JOIN managed_accounts a ON a.id=s.account_id " +
      "JOIN managed_memberships m ON m.household_id=s.household_id " +
      "AND m.account_id=s.account_id " +
      "JOIN managed_families f ON f.id=s.household_id " +
      "WHERE s.token_sha256=? AND c.id=? AND c.consumed_at IS NULL " +
      "AND c.expires_at>unixepoch('now') " +
      "AND s.revoked_at IS NULL AND s.expires_at>unixepoch('now') " +
      "AND s.account_auth_version=a.auth_version " +
      "AND s.membership_auth_version=m.auth_version " +
      "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state='active' AND f.state='active'",
    ).get(token, challengeId);
  }

  private checkChallenge(row: ChallengeRow | undefined, csrfToken: string,
    nonce: Uint8Array): asserts row is ChallengeRow {
    if (!row || !verifyCsrfToken(csrfToken, row.sessionId, row.csrfSecret) ||
      !equalDigest(sha256(nonce), row.challengeSha256) ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt <= databaseNow(this.db))
      throw new ManagedDeviceEnrollmentDenied();
  }
}

function sameChallenge(a: ChallengeRow, b: ChallengeRow): boolean {
  return a.householdId === b.householdId && a.accountId === b.accountId &&
    a.sessionId === b.sessionId && a.challengeId === b.challengeId &&
    a.expiresAt === b.expiresAt &&
    equalDigest(a.challengeSha256, b.challengeSha256) &&
    equalDigest(a.encryptionPublicKey, b.encryptionPublicKey) &&
    equalDigest(a.signingPublicKey, b.signingPublicKey) &&
    equalDigest(a.csrfSecret, b.csrfSecret);
}

function checkSessionInput(tokenSha256: string, csrfToken: string): void {
  if (typeof tokenSha256 !== "string" || !SHA256.test(tokenSha256) ||
    typeof csrfToken !== "string" || csrfToken.length > 256)
    throw new ManagedDeviceEnrollmentDenied();
}

function keyFromHex(value: string): Buffer {
  if (typeof value !== "string" || !SHA256.test(value))
    throw new ManagedDeviceEnrollmentDenied();
  return Buffer.from(value, "hex");
}

function deriveX25519Secret(raw: Buffer): {
  ephemeralPublicKey: Buffer; sharedSecret: Buffer } {
  try {
    const publicKey = createPublicKey({ key: Buffer.concat([
      X25519_SPKI_PREFIX, raw,
    ]), format: "der", type: "spki" });
    const ephemeral = generateKeyPairSync("x25519");
    const sharedSecret = diffieHellman({
      privateKey: ephemeral.privateKey, publicKey });
    const ephemeralPublicKey = ephemeral.publicKey.export({
      format: "der", type: "spki" }).subarray(-32);
    if (sharedSecret.byteLength !== 32 ||
      ephemeralPublicKey.byteLength !== 32)
      throw new ManagedDeviceEnrollmentDenied();
    return { ephemeralPublicKey, sharedSecret };
  } catch { throw new ManagedDeviceEnrollmentDenied(); }
}

function databaseNow(db: Database.Database): number {
  const now = db.prepare<[], { now: number }>(
    "SELECT unixepoch('now') AS now").get()?.now;
  if (!Number.isSafeInteger(now) || now! < 1)
    throw new ManagedDeviceEnrollmentDenied();
  return now!;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return Buffer.isBuffer(right) && right.byteLength === 32 &&
    timingSafeEqual(left, right);
}
