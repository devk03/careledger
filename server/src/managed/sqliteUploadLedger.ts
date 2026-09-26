import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { MANAGED_VAULT_CHUNK_BYTES, MAX_MANAGED_VAULT_BYTES } from
  "@adeno/contracts";
import Database from "better-sqlite3";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { ManagedVaultUploadDeniedError, ManagedVaultUploadExistsError,
  ManagedVaultUploadSessionError } from "./ciphertextAdmission.js";
import { MANAGED_APPLICATION_ID, MANAGED_MIGRATIONS } from
  "./managedSchemaManifest.js";
import type { ManagedStagingIntent, ManagedUploadLedger,
  VerifiedUploadChunkRow } from "./stagedUploadStore.js";
import { ManagedUploadReceiptCsrfError, type ManagedUploadReceiptReader,
  type ManagedUploadReceipt } from
  "./uploadReceipt.js";

const HEX_32 = /^[0-9a-f]{32}$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const MAX_WIRE_BYTES = 33 + MAX_MANAGED_VAULT_BYTES +
  32 * Math.ceil(MAX_MANAGED_VAULT_BYTES / MANAGED_VAULT_CHUNK_BYTES);

type MigrationRow = { version: number; name: string; sha256: string };
type SessionRow = {
  householdId: string;
  accountId: string;
  sessionId: string;
  boundDeviceId: string;
  csrfSecret: Buffer;
};
type IntentRow = {
  householdId: string;
  accountId: string;
  sessionId: string;
  intentId: string;
  blobId: string;
  profileId: string;
  scopeId: string;
  keyId: string;
  epoch: number;
  writerDeviceId: string;
  plaintextBytes: number;
  chunkCount: number;
};

export class IncompatibleManagedLedger extends Error {
  constructor() { super("Managed ciphertext ledger unavailable or incompatible"); }
}

/**
 * Unmounted, existing-schema-only ciphertext publication ledger. This is not
 * an intake service: issuing signed intents, global disk quota, orphan
 * reconciliation and care-day CAS publication remain separate gates. Aborted
 * leases stay charged until a separately reviewed cleanup path exists.
 * Never point it at a community/pilot database or real family records yet.
 */
export class SqliteManagedUploadLedger implements ManagedUploadLedger,
  ManagedUploadReceiptReader {
  private readonly db: Database.Database;
  private readonly maxStoredBytesPerFamily: number;

  constructor(path: string, maxStoredBytesPerFamily: number) {
    if (!isAbsolute(path) || !Number.isSafeInteger(maxStoredBytesPerFamily) ||
      maxStoredBytesPerFamily < 65)
      throw new IncompatibleManagedLedger();
    assertPrivateDirectory(dirname(path));
    assertPrivateFile(path, true);
    assertPrivateFile(`${path}-wal`, false);
    assertPrivateFile(`${path}-shm`, false);
    let db: Database.Database | undefined;
    try {
      db = new Database(path, { fileMustExist: true, timeout: 5_000 });
      db.pragma("foreign_keys = ON");
      db.pragma("trusted_schema = OFF");
      verifySchema(db);
    } catch {
      db?.close();
      throw new IncompatibleManagedLedger();
    }
    this.db = db;
    this.maxStoredBytesPerFamily = maxStoredBytesPerFamily;
  }

  async openForStaging(input: Parameters<ManagedUploadLedger["openForStaging"]>[0]):
    Promise<ManagedStagingIntent | null> {
    if (input.signal.aborted || !HEX_32.test(input.intentId)) return null;
    const session = this.currentSession(input.tokenSha256, input.csrfToken);
    if (!session || session.householdId !== input.session.scope.householdId ||
      session.accountId !== input.session.scope.userId ||
      session.sessionId !== input.session.sessionId)
      throw new ManagedVaultUploadSessionError();
    const reserve = this.db.transaction(() => {
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      const currentSession = this.currentSession(input.tokenSha256, input.csrfToken);
      if (!currentSession || currentSession.householdId !== session.householdId ||
        currentSession.accountId !== session.accountId ||
        currentSession.sessionId !== session.sessionId)
        throw new ManagedVaultUploadSessionError();
      const row = this.currentIntent(currentSession, input.intentId);
      if (!row) return null;
      const wireBytes = 33 + row.plaintextBytes + 32 * row.chunkCount;
      if (!this.withinFamilyQuota(row.householdId, wireBytes))
        throw new ManagedVaultUploadDeniedError();
      const attemptId = randomBytes(16).toString("hex");
      this.db.prepare<[string, string, string, number, number]>(
        "INSERT INTO managed_staging_leases " +
        "(household_id, intent_id, attempt_id, reserved_bytes, opened_at) " +
        "VALUES (?, ?, ?, ?, ?)",
      ).run(row.householdId, row.intentId, attemptId, wireBytes,
        Math.floor(Date.now() / 1000));
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      return asStagingIntent(row, attemptId);
    });
    try { return reserve.immediate(); } catch (error) {
      if (isUniqueConstraint(error)) throw new ManagedVaultUploadExistsError();
      throw error;
    }
  }

  async publishVerified(input: Parameters<ManagedUploadLedger["publishVerified"]>[0]):
    Promise<void> {
    if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
    if (!HEX_32.test(input.intent.householdId) ||
      !HEX_32.test(input.intent.intentId) || !HEX_32.test(input.intent.blobId) ||
      !Buffer.isBuffer(input.wireSha256) || input.wireSha256.length !== 32 ||
      !Number.isSafeInteger(input.wireBytes) || input.wireBytes < 65 ||
      input.wireBytes > MAX_WIRE_BYTES)
      throw new ManagedVaultUploadDeniedError();

    const publish = this.db.transaction(() => {
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      const session = this.currentSession(input.tokenSha256, input.csrfToken);
      if (!session || session.householdId !== input.intent.householdId ||
        session.accountId !== input.intent.accountId ||
        session.sessionId !== input.intent.sessionId)
        throw new ManagedVaultUploadSessionError();
      const row = this.currentIntent(session, input.intent.intentId);
      if (!row || !sameIntent(input.intent, row))
        throw new ManagedVaultUploadDeniedError();
      const lease = this.db.prepare<[string, string, string],
        { reservedBytes: number }>(
        "SELECT reserved_bytes AS reservedBytes FROM managed_staging_leases " +
        "WHERE household_id = ? AND intent_id = ? AND attempt_id = ? " +
        "AND committed_at IS NULL",
      ).get(row.householdId, row.intentId, input.intent.attemptId);
      if (!lease || lease.reservedBytes !== input.wireBytes)
        throw new ManagedVaultUploadDeniedError();
      if (input.chunks.length !== row.chunkCount ||
        input.wireBytes !== 33 + row.plaintextBytes + 32 * row.chunkCount ||
        !validChunks(input.chunks, row.plaintextBytes))
        throw new ManagedVaultUploadDeniedError();
      if (!this.withinFamilyQuota(row.householdId, 0))
        throw new ManagedVaultUploadDeniedError();

      const now = Math.floor(Date.now() / 1000);
      const reserve = this.db.prepare<[
        string, string, number, Buffer, string, number, number
      ]>("INSERT INTO managed_nonce_reservations " +
        "(household_id, key_id, epoch, nonce, intent_id, chunk_index, reserved_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)");
      const insertChunk = this.db.prepare<[
        string, string, number, Buffer, string, number, Buffer
      ]>("INSERT INTO managed_blob_chunks " +
        "(household_id, intent_id, chunk_index, nonce, storage_object_id, " +
        "ciphertext_bytes, ciphertext_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const chunk of input.chunks) {
        if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
        reserve.run(row.householdId, row.keyId, row.epoch, chunk.iv,
          row.intentId, chunk.index, now);
        insertChunk.run(row.householdId, row.intentId, chunk.index, chunk.iv,
          chunk.storageObjectId, chunk.ciphertextBytes, chunk.ciphertextSha256);
      }
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      this.db.prepare<[
        string, string, string, string, string, string, number, string,
        Buffer, number, number
      ]>("INSERT INTO managed_committed_blobs " +
        "(household_id, blob_id, intent_id, profile_id, scope_id, key_id, " +
        "epoch, writer_device_id, wire_version, wire_sha256, wire_bytes, committed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?)").run(
        row.householdId, row.blobId, row.intentId, row.profileId, row.scopeId,
        row.keyId, row.epoch, row.writerDeviceId, input.wireSha256,
        input.wireBytes, now);
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
    });
    try {
      publish.immediate();
    } catch (error) {
      if (error instanceof ManagedVaultUploadDeniedError ||
        error instanceof ManagedVaultUploadSessionError) throw error;
      if (typeof error === "object" && error !== null && "code" in error) {
        if (isUniqueConstraint(error)) throw new ManagedVaultUploadExistsError();
        if (error.code === "SQLITE_CONSTRAINT_TRIGGER")
          throw new ManagedVaultUploadDeniedError();
      }
      throw error;
    }
  }

  close(): void { this.db.close(); }

  async readReceipt(input: Parameters<ManagedUploadReceiptReader["readReceipt"]>[0]):
    Promise<ManagedUploadReceipt | null> {
    const read = this.db.transaction((): ManagedUploadReceipt | null => {
      const session = this.sessionByToken(input.tokenSha256);
      if (!session) throw new ManagedVaultUploadSessionError();
      if (!verifyCsrfToken(input.csrfToken, session.sessionId, session.csrfSecret))
        throw new ManagedUploadReceiptCsrfError();
      if (!HEX_32.test(input.intentId) || !HEX_32.test(input.blobId)) return null;
      const row = this.db.prepare<[string, string, string, string, string],
        { wireSha256: Buffer | null; wireBytes: number | null }>(
        "SELECT b.wire_sha256 AS wireSha256, b.wire_bytes AS wireBytes " +
        "FROM managed_upload_intents i " +
        "JOIN managed_devices d ON d.household_id = i.household_id " +
        "AND d.id = i.writer_device_id " +
        "JOIN managed_grant_heads g ON g.household_id = i.household_id " +
        "AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id " +
        "AND g.subject_device_id = i.writer_device_id " +
        "JOIN managed_scopes sc ON sc.household_id = i.household_id " +
        "AND sc.profile_id = i.profile_id AND sc.id = i.scope_id " +
        "JOIN managed_profiles p ON p.household_id = i.household_id " +
        "AND p.id = i.profile_id " +
        "LEFT JOIN managed_committed_blobs b ON b.household_id = i.household_id " +
        "AND b.intent_id = i.id AND b.blob_id = i.blob_id " +
        "WHERE i.household_id = ? AND i.id = ? AND i.blob_id = ? " +
        "AND i.writer_device_id = ? " +
        "AND d.account_id = ? AND d.state = 'active' " +
        "AND (g.capability_mask & 2) = 2 AND sc.state = 'active' " +
        "AND p.state = 'active'",
      ).get(session.householdId, input.intentId, input.blobId,
        session.boundDeviceId, session.accountId);
      if (!row) return null;
      if (row.wireSha256 === null) return { status: "unconfirmed" };
      if (!Buffer.isBuffer(row.wireSha256) || row.wireSha256.length !== 32 ||
        !Number.isSafeInteger(row.wireBytes) || row.wireBytes === null ||
        row.wireBytes < 65 || row.wireBytes > MAX_WIRE_BYTES)
        throw new IncompatibleManagedLedger();
      return { status: "committed", wireSha256: row.wireSha256.toString("hex"),
        wireBytes: row.wireBytes };
    });
    return read.deferred();
  }

  /** Count committed wires plus every uncommitted physical reservation. */
  private withinFamilyQuota(householdId: string, additionalBytes: number): boolean {
    const usage = this.db.prepare<[string], { bytes: number }>(
      "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM managed_wire_occupancy " +
      "WHERE household_id = ?",
    ).get(householdId);
    return !!usage && Number.isSafeInteger(usage.bytes) &&
      usage.bytes <= this.maxStoredBytesPerFamily - additionalBytes;
  }

  private currentSession(tokenSha256: string, csrfToken: string): SessionRow | null {
    const row = this.sessionByToken(tokenSha256);
    if (!row || !verifyCsrfToken(csrfToken, row.sessionId, row.csrfSecret)) return null;
    return row;
  }

  private sessionByToken(tokenSha256: string): SessionRow | null {
    if (!HEX_64.test(tokenSha256)) return null;
    const row = this.db.prepare<[Buffer], SessionRow>(
      "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
      "s.id AS sessionId, binding.device_id AS boundDeviceId, " +
      "s.csrf_secret AS csrfSecret " +
      "FROM managed_sessions s " +
      "JOIN managed_accounts a ON a.id = s.account_id " +
      "JOIN managed_memberships m ON m.household_id = s.household_id " +
      "AND m.account_id = s.account_id " +
      "JOIN managed_families f ON f.id = s.household_id " +
      "JOIN managed_session_device_bindings binding " +
      "ON binding.household_id = s.household_id " +
      "AND binding.account_id = s.account_id AND binding.session_id = s.id " +
      "JOIN managed_devices bound_device " +
      "ON bound_device.household_id = binding.household_id " +
      "AND bound_device.account_id = binding.account_id " +
      "AND bound_device.id = binding.device_id " +
      "WHERE s.token_sha256 = ? AND s.revoked_at IS NULL " +
      "AND s.expires_at > unixepoch('now') " +
      "AND s.account_auth_version = a.auth_version " +
      "AND s.membership_auth_version = m.auth_version " +
      "AND a.state = 'active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state = 'active' " +
      "AND f.state = 'active' AND bound_device.state = 'active'",
    ).get(Buffer.from(tokenSha256, "hex"));
    if (!row || !Buffer.isBuffer(row.csrfSecret) || row.csrfSecret.length !== 32)
      return null;
    return row;
  }

  private currentIntent(session: SessionRow, intentId: string): IntentRow | null {
    const row = this.db.prepare<[
      string, string, string, string, string
    ], IntentRow>(
      "SELECT i.household_id AS householdId, d.account_id AS accountId, " +
      "i.session_id AS sessionId, i.id AS intentId, i.blob_id AS blobId, " +
      "i.profile_id AS profileId, i.scope_id AS scopeId, i.key_id AS keyId, " +
      "i.epoch AS epoch, i.writer_device_id AS writerDeviceId, " +
      "i.plaintext_bytes AS plaintextBytes, i.chunk_count AS chunkCount " +
      "FROM managed_upload_intents i " +
      "JOIN managed_devices d ON d.household_id = i.household_id " +
      "AND d.id = i.writer_device_id " +
      "JOIN managed_grant_heads g ON g.household_id = i.household_id " +
      "AND g.profile_id = i.profile_id AND g.scope_id = i.scope_id " +
      "AND g.subject_device_id = i.writer_device_id " +
      "JOIN managed_scopes sc ON sc.household_id = i.household_id " +
      "AND sc.profile_id = i.profile_id AND sc.id = i.scope_id " +
      "JOIN managed_profiles p ON p.household_id = i.household_id " +
      "AND p.id = i.profile_id " +
      "JOIN managed_key_identities k ON k.household_id = i.household_id " +
      "AND k.key_id = i.key_id AND k.epoch = i.epoch " +
      "JOIN managed_current_scope_keys current_key " +
      "ON current_key.household_id = i.household_id " +
      "AND current_key.profile_id = i.profile_id " +
      "AND current_key.scope_id = i.scope_id " +
      "AND current_key.key_id = i.key_id " +
      "AND current_key.epoch = i.epoch " +
      "WHERE i.household_id = ? AND i.session_id = ? AND i.id = ? " +
      "AND i.writer_device_id = ? " +
      "AND d.account_id = ? AND d.state = 'active' " +
      "AND (g.capability_mask & 2) = 2 AND sc.state = 'active' " +
      "AND sc.kind = 'day' AND p.state = 'active' " +
      "AND k.profile_id = i.profile_id AND k.scope_id = i.scope_id " +
      "AND k.purpose = 'day' AND i.purpose = 'day' AND i.wire_version = 2 " +
      "AND i.consumed_at IS NULL AND i.expires_at > unixepoch('now')",
    ).get(session.householdId, session.sessionId, intentId,
      session.boundDeviceId, session.accountId);
    return row ?? null;
  }
}

function asStagingIntent(row: IntentRow, attemptId: string): ManagedStagingIntent {
  return { householdId: row.householdId, accountId: row.accountId,
    sessionId: row.sessionId, intentId: row.intentId, attemptId,
    blobId: row.blobId,
    plaintextBytes: row.plaintextBytes, chunkCount: row.chunkCount };
}

function sameIntent(expected: ManagedStagingIntent, actual: IntentRow): boolean {
  if (!HEX_32.test(expected.attemptId)) return false;
  const value = asStagingIntent(actual, expected.attemptId);
  return Object.keys(value).every((key) =>
    value[key as keyof ManagedStagingIntent] ===
      expected[key as keyof ManagedStagingIntent]);
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      error.code === "SQLITE_CONSTRAINT_UNIQUE");
}

function validChunks(chunks: readonly VerifiedUploadChunkRow[], plaintextBytes: number): boolean {
  const seenObjects = new Set<string>();
  const seenNonces = new Set<string>();
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (!chunk || chunk.index !== index || !Buffer.isBuffer(chunk.iv) ||
      chunk.iv.length !== 12 || seenNonces.has(chunk.iv.toString("hex")) ||
      !HEX_32.test(chunk.storageObjectId) ||
      seenObjects.has(chunk.storageObjectId) ||
      !Buffer.isBuffer(chunk.ciphertextSha256) ||
      chunk.ciphertextSha256.length !== 32 ||
      chunk.ciphertextBytes !== 16 + Math.max(0, Math.min(
        MANAGED_VAULT_CHUNK_BYTES, plaintextBytes - index * MANAGED_VAULT_CHUNK_BYTES)))
      return false;
    seenObjects.add(chunk.storageObjectId);
    seenNonces.add(chunk.iv.toString("hex"));
  }
  return true;
}

function assertPrivateFile(path: string, required: boolean): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new IncompatibleManagedLedger();
  } catch (error) {
    if (!required && typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT") return;
    throw new IncompatibleManagedLedger();
  }
}

function assertPrivateDirectory(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new IncompatibleManagedLedger();
  } catch {
    throw new IncompatibleManagedLedger();
  }
}

function verifySchema(db: Database.Database): void {
  if (db.pragma("application_id", { simple: true }) !== MANAGED_APPLICATION_ID ||
    db.pragma("user_version", { simple: true }) !== MANAGED_MIGRATIONS.length)
    throw new IncompatibleManagedLedger();
  const rows = db.prepare<[], MigrationRow>(
    "SELECT version, name, sha256 FROM managed_schema_migrations ORDER BY version",
  ).all();
  if (rows.length !== MANAGED_MIGRATIONS.length || rows.some((row, index) => {
    const expected = MANAGED_MIGRATIONS[index];
    return !expected || row.version !== expected[0] ||
      row.name !== expected[1] || row.sha256 !== expected[2];
  })) throw new IncompatibleManagedLedger();
  if (db.prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
    .get()?.integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").get() !== undefined)
    throw new IncompatibleManagedLedger();
}
