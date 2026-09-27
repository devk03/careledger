import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { MANAGED_VAULT_CHUNK_BYTES, MAX_MANAGED_VAULT_WIRE_BYTES } from
  "@adeno/contracts";
import type Database from "better-sqlite3";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { ManagedVaultUploadDeniedError, ManagedVaultUploadExistsError,
  ManagedVaultUploadSessionError } from "./ciphertextAdmission.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";
import type { ManagedStagingIntent, ManagedUploadLedger,
  VerifiedUploadChunkRow } from "./stagedUploadStore.js";
import { ManagedUploadReceiptCsrfError, type ManagedUploadReceipt,
  type ManagedUploadReceiptReader } from "./uploadReceipt.js";

const ID = /^[0-9a-f]{32}$/u;
const TOKEN_HASH = /^[0-9a-f]{64}$/u;

type Session = { householdId: string; accountId: string;
  sessionId: string; deviceId: string; csrfSecret: Buffer };
type Intent = { householdId: string; accountId: string; sessionId: string;
  intentId: string; blobId: string; profileId: string; scopeId: string;
  keyId: string; epoch: number; writerDeviceId: string;
  role: "content" | "metadata"; objectId: string; aadRevision: number;
  plaintextBytes: number; chunkCount: number; attemptId: string;
  reservedBytes: number };

export class IncompatibleNonDayDraftLedger extends Error {
  constructor() { super("Managed draft ciphertext ledger unavailable"); }
}

/**
 * Unmounted v10-only adapter for a draft whose two leases were already opened
 * atomically by SqliteDraftPairReservation. It never opens a new lease. Disk
 * proof is supplied by createStagedManagedVaultUploadStore, not this class.
 * V10 has no safe abandoned-lease release or non-day SQL device-binding guard;
 * do not mount this adapter until those and physical quota/recovery are fixed.
 */
export class SqliteNonDayDraftUploadLedger implements ManagedUploadLedger,
  ManagedUploadReceiptReader {
  private readonly sourcePath: string;
  private readonly canonicalPath: string;
  private readonly schemaVersion: number;
  private readonly journalMode: "wal" | "delete";
  private readonly synchronousLevel: 2 | 3;

  constructor(private readonly db: Database.Database,
    private readonly maxFamilyBytes: number,
    private readonly maxGlobalBytes: number) {
    if (!Number.isSafeInteger(maxFamilyBytes) || maxFamilyBytes < 65 ||
      !Number.isSafeInteger(maxGlobalBytes) || maxGlobalBytes < 65 ||
      typeof db?.name !== "string" || !isAbsolute(db.name))
      throw new IncompatibleNonDayDraftLedger();
    this.sourcePath = db.name;
    privateDirectory(dirname(this.sourcePath));
    privateFile(this.sourcePath, true);
    this.canonicalPath = realpathSync(db.name);
    this.schemaVersion = db.pragma("main.schema_version", { simple: true }) as number;
    this.journalMode = db.pragma("main.journal_mode", { simple: true }) as
      "wal" | "delete";
    this.synchronousLevel = db.pragma("main.synchronous", { simple: true }) as
      2 | 3;
    this.assertOperational();
    if (db.prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
      .get()?.integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").get() !== undefined)
      throw new IncompatibleNonDayDraftLedger();
  }

  async openForStaging(input: Parameters<ManagedUploadLedger["openForStaging"]>[0]):
    Promise<ManagedStagingIntent | null> {
    if (input.signal.aborted || !ID.test(input.intentId)) return null;
    const open = this.db.transaction(() => {
      this.assertOperational();
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      const session = this.requireSession(input.tokenSha256, input.csrfToken);
      if (session.householdId !== input.session.scope.householdId ||
        session.accountId !== input.session.scope.userId ||
        session.sessionId !== input.session.sessionId)
        throw new ManagedVaultUploadSessionError();
      const intent = this.currentIntent(session, input.intentId);
      if (!intent) return null;
      if (!this.withinQuota(intent.householdId))
        throw new ManagedVaultUploadDeniedError();
      return asStagingIntent(intent);
    });
    return open.immediate();
  }

  async publishVerified(input: Parameters<ManagedUploadLedger["publishVerified"]>[0]):
    Promise<void> {
    if (input.signal.aborted || !ID.test(input.intent.householdId) ||
      !ID.test(input.intent.intentId) || !ID.test(input.intent.blobId) ||
      !ID.test(input.intent.attemptId) ||
      !Buffer.isBuffer(input.wireSha256) || input.wireSha256.length !== 32 ||
      !Number.isSafeInteger(input.wireBytes) || input.wireBytes < 66 ||
      input.wireBytes > MAX_MANAGED_VAULT_WIRE_BYTES)
      throw new ManagedVaultUploadDeniedError();
    const publish = this.db.transaction(() => {
      this.assertOperational();
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      const session = this.requireSession(input.tokenSha256, input.csrfToken);
      const row = this.currentIntent(session, input.intent.intentId);
      if (!row || !sameIntent(input.intent, row) ||
        row.reservedBytes !== input.wireBytes ||
        input.wireBytes !== 33 + row.plaintextBytes + 32 * row.chunkCount ||
        input.chunks.length !== row.chunkCount ||
        !validChunks(input.chunks, row.plaintextBytes) ||
        !this.withinQuota(row.householdId))
        throw new ManagedVaultUploadDeniedError();
      const now = this.now();
      const nonce = this.db.prepare(
        "INSERT INTO managed_non_day_nonce_reservations " +
        "(household_id,key_id,epoch,nonce,intent_id,chunk_index,reserved_at) " +
        "VALUES (?,?,?,?,?,?,?)",
      );
      const chunkInsert = this.db.prepare(
        "INSERT INTO managed_non_day_blob_chunks " +
        "(household_id,intent_id,chunk_index,nonce,storage_object_id," +
        "ciphertext_bytes,ciphertext_sha256) VALUES (?,?,?,?,?,?,?)",
      );
      for (const chunk of input.chunks) {
        if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
        nonce.run(row.householdId, row.keyId, row.epoch, chunk.iv,
          row.intentId, chunk.index, now);
        chunkInsert.run(row.householdId, row.intentId, chunk.index,
          chunk.iv, chunk.storageObjectId, chunk.ciphertextBytes,
          chunk.ciphertextSha256);
      }
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
      this.db.prepare(
        "INSERT INTO managed_non_day_committed_blobs " +
        "(household_id,blob_id,intent_id,profile_id,scope_id,key_id,epoch," +
        "purpose,role,object_id,aad_revision,writer_device_id,wire_version," +
        "wire_sha256,wire_bytes,committed_at) VALUES " +
        "(?,?,?,?,?,?,?,'draft',?,?,?,?,2,?,?,?)",
      ).run(row.householdId, row.blobId, row.intentId, row.profileId,
        row.scopeId, row.keyId, row.epoch, row.role, row.objectId,
        row.aadRevision, row.writerDeviceId, input.wireSha256,
        input.wireBytes, now);
      if (input.signal.aborted) throw new ManagedVaultUploadDeniedError();
    });
    try { publish.immediate(); } catch (error) {
      if (error instanceof ManagedVaultUploadDeniedError ||
        error instanceof ManagedVaultUploadSessionError) throw error;
      if (isUniqueConstraint(error)) throw new ManagedVaultUploadExistsError();
      if (isConstraint(error)) throw new ManagedVaultUploadDeniedError();
      throw error;
    }
  }

  async readReceipt(input: Parameters<ManagedUploadReceiptReader["readReceipt"]>[0]):
    Promise<ManagedUploadReceipt | null> {
    const read = this.db.transaction((): ManagedUploadReceipt | null => {
      this.assertOperational();
      const session = this.sessionByToken(input.tokenSha256);
      if (!session) throw new ManagedVaultUploadSessionError();
      if (!verifyCsrfToken(input.csrfToken, session.sessionId,
        session.csrfSecret)) throw new ManagedUploadReceiptCsrfError();
      if (!ID.test(input.intentId) || !ID.test(input.blobId)) return null;
      const row = this.db.prepare<[string, string, string, string, string],
        { wireSha256: Buffer | null; wireBytes: number | null }>(
        "SELECT b.wire_sha256 AS wireSha256, b.wire_bytes AS wireBytes " +
        "FROM managed_non_day_upload_intents i " +
        "JOIN managed_draft_reservations r ON r.household_id=i.household_id " +
        "AND r.id=i.draft_reservation_id " +
        "JOIN managed_devices d ON d.household_id=i.household_id " +
        "AND d.id=i.writer_device_id " +
        "JOIN managed_grant_heads g ON g.household_id=i.household_id " +
        "AND g.profile_id=i.profile_id AND g.scope_id=i.scope_id " +
        "AND g.subject_device_id=i.writer_device_id " +
        "JOIN managed_scopes sc ON sc.household_id=i.household_id " +
        "AND sc.profile_id=i.profile_id AND sc.id=i.scope_id " +
        "JOIN managed_profiles p ON p.household_id=i.household_id " +
        "AND p.id=i.profile_id " +
        "LEFT JOIN managed_non_day_committed_blobs b " +
        "ON b.household_id=i.household_id AND b.intent_id=i.id " +
        "AND b.blob_id=i.blob_id " +
        "WHERE i.household_id=? AND i.id=? AND i.blob_id=? " +
        "AND i.writer_device_id=? AND d.account_id=? " +
        "AND i.purpose='draft' AND i.role IN ('content','metadata') " +
        "AND d.state='active' AND (g.capability_mask & 2)=2 " +
        "AND sc.kind='draft' AND sc.state='active' AND p.state='active'",
      ).get(session.householdId, input.intentId, input.blobId,
        session.deviceId, session.accountId);
      if (!row) return null;
      if (row.wireSha256 === null) return { status: "unconfirmed" };
      if (!Buffer.isBuffer(row.wireSha256) || row.wireSha256.length !== 32 ||
        !Number.isSafeInteger(row.wireBytes) || row.wireBytes === null ||
        row.wireBytes < 66 || row.wireBytes > MAX_MANAGED_VAULT_WIRE_BYTES)
        throw new IncompatibleNonDayDraftLedger();
      return { status: "committed", wireSha256: row.wireSha256.toString("hex"),
        wireBytes: row.wireBytes };
    });
    return read.deferred();
  }

  private currentIntent(session: Session, intentId: string): Intent | null {
    const row = this.db.prepare<[string, string, string, string, string], Intent>(
      "SELECT i.household_id AS householdId, d.account_id AS accountId, " +
      "i.session_id AS sessionId, i.id AS intentId, i.blob_id AS blobId, " +
      "i.profile_id AS profileId, i.scope_id AS scopeId, i.key_id AS keyId, " +
      "i.epoch, i.writer_device_id AS writerDeviceId, i.role, " +
      "i.object_id AS objectId, i.aad_revision AS aadRevision, " +
      "i.plaintext_bytes AS plaintextBytes, i.chunk_count AS chunkCount, " +
      "l.attempt_id AS attemptId, l.reserved_bytes AS reservedBytes " +
      "FROM managed_non_day_upload_intents i " +
      "JOIN managed_draft_reservations r ON r.household_id=i.household_id " +
      "AND r.id=i.draft_reservation_id " +
      "JOIN managed_non_day_staging_leases l ON l.household_id=i.household_id " +
      "AND l.intent_id=i.id " +
      "JOIN managed_devices d ON d.household_id=i.household_id " +
      "AND d.id=i.writer_device_id " +
      "JOIN managed_grant_heads g ON g.household_id=i.household_id " +
      "AND g.profile_id=i.profile_id AND g.scope_id=i.scope_id " +
      "AND g.subject_device_id=i.writer_device_id " +
      "JOIN managed_scopes sc ON sc.household_id=i.household_id " +
      "AND sc.profile_id=i.profile_id AND sc.id=i.scope_id " +
      "JOIN managed_profiles p ON p.household_id=i.household_id " +
      "AND p.id=i.profile_id " +
      "JOIN managed_key_identities k ON k.household_id=i.household_id " +
      "AND k.key_id=i.key_id AND k.epoch=i.epoch " +
      "JOIN managed_current_scope_keys current_key " +
      "ON current_key.household_id=i.household_id " +
      "AND current_key.profile_id=i.profile_id " +
      "AND current_key.scope_id=i.scope_id " +
      "AND current_key.key_id=i.key_id AND current_key.epoch=i.epoch " +
      "WHERE i.household_id=? AND i.session_id=? AND i.id=? " +
      "AND i.writer_device_id=? AND d.account_id=? " +
      "AND i.purpose='draft' AND i.role IN ('content','metadata') " +
      "AND r.profile_id=i.profile_id AND r.scope_id=i.scope_id " +
      "AND r.key_id=i.key_id AND r.epoch=i.epoch " +
      "AND r.writer_device_id=i.writer_device_id " +
      "AND r.session_id=i.session_id " +
      "AND ((i.role='content' AND r.content_intent_id=i.id " +
      "AND r.content_blob_id=i.blob_id) OR " +
      "(i.role='metadata' AND r.metadata_intent_id=i.id " +
      "AND r.metadata_blob_id=i.blob_id)) " +
      "AND 2=(SELECT count(*) FROM managed_non_day_upload_intents peer " +
      "JOIN managed_non_day_staging_leases peer_lease " +
      "ON peer_lease.household_id=peer.household_id " +
      "AND peer_lease.intent_id=peer.id " +
      "WHERE peer.household_id=i.household_id " +
      "AND peer.draft_reservation_id=r.id) " +
      "AND i.consumed_at IS NULL AND i.expires_at>unixepoch('now') " +
      "AND r.expires_at>unixepoch('now') AND l.committed_at IS NULL " +
      "AND d.state='active' AND (g.capability_mask & 2)=2 " +
      "AND sc.kind='draft' AND sc.state='active' AND p.state='active' " +
      "AND k.profile_id=i.profile_id AND k.scope_id=i.scope_id " +
      "AND k.purpose='draft' AND i.wire_version=2",
    ).get(session.householdId, session.sessionId, intentId,
      session.deviceId, session.accountId);
    return row ?? null;
  }

  private requireSession(tokenSha256: string, csrfToken: string): Session {
    const session = this.sessionByToken(tokenSha256);
    if (!session || !verifyCsrfToken(csrfToken, session.sessionId,
      session.csrfSecret)) throw new ManagedVaultUploadSessionError();
    return session;
  }

  private sessionByToken(tokenSha256: string): Session | null {
    if (!TOKEN_HASH.test(tokenSha256)) return null;
    const row = this.db.prepare<[Buffer], Session>(
      "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
      "s.id AS sessionId, binding.device_id AS deviceId, " +
      "s.csrf_secret AS csrfSecret FROM managed_sessions s " +
      "JOIN managed_accounts a ON a.id=s.account_id " +
      "JOIN managed_memberships m ON m.household_id=s.household_id " +
      "AND m.account_id=s.account_id " +
      "JOIN managed_families f ON f.id=s.household_id " +
      "JOIN managed_session_device_bindings binding " +
      "ON binding.household_id=s.household_id " +
      "AND binding.account_id=s.account_id AND binding.session_id=s.id " +
      "JOIN managed_devices d ON d.household_id=binding.household_id " +
      "AND d.account_id=binding.account_id AND d.id=binding.device_id " +
      "WHERE s.token_sha256=? AND s.revoked_at IS NULL " +
      "AND s.expires_at>unixepoch('now') " +
      "AND s.account_auth_version=a.auth_version " +
      "AND s.membership_auth_version=m.auth_version " +
      "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state='active' AND f.state='active' AND d.state='active'",
    ).get(Buffer.from(tokenSha256, "hex"));
    return row && Buffer.isBuffer(row.csrfSecret) &&
      row.csrfSecret.length === 32 ? row : null;
  }

  private withinQuota(householdId: string): boolean {
    const usage = this.db.prepare<[string], { familyBytes: number;
      globalBytes: number }>(
      "SELECT COALESCE(SUM(CASE WHEN household_id=? THEN bytes ELSE 0 END),0) " +
      "AS familyBytes, COALESCE(SUM(bytes),0) AS globalBytes " +
      "FROM managed_wire_occupancy",
    ).get(householdId);
    return !!usage && Number.isSafeInteger(usage.familyBytes) &&
      Number.isSafeInteger(usage.globalBytes) && usage.familyBytes >= 0 &&
      usage.globalBytes >= 0 && usage.familyBytes <= this.maxFamilyBytes &&
      usage.globalBytes <= this.maxGlobalBytes;
  }

  private now(): number {
    const now = this.db.prepare<[], { now: number }>(
      "SELECT unixepoch('now') AS now").get()?.now;
    if (!Number.isSafeInteger(now) || now! <= 0)
      throw new IncompatibleNonDayDraftLedger();
    return now!;
  }

  private assertOperational(): void {
    try {
      privateDirectory(dirname(this.sourcePath));
      privateFile(this.sourcePath, true);
      if (realpathSync(this.sourcePath) !== this.canonicalPath)
        throw new IncompatibleNonDayDraftLedger();
      privateDirectory(dirname(this.canonicalPath));
      privateFile(this.canonicalPath, true);
      privateFile(`${this.canonicalPath}-wal`, false);
      privateFile(`${this.canonicalPath}-shm`, false);
      const databases = this.db.prepare<[], { name: string; file: string }>(
        "PRAGMA database_list").all();
      if (this.db.readonly ||
        this.db.pragma("query_only", { simple: true }) !== 0 ||
        this.db.pragma("foreign_keys", { simple: true }) !== 1 ||
        this.db.pragma("trusted_schema", { simple: true }) !== 0 ||
        this.db.pragma("main.schema_version", { simple: true }) !==
          this.schemaVersion ||
        this.db.pragma("main.journal_mode", { simple: true }) !==
          this.journalMode ||
        this.db.pragma("main.synchronous", { simple: true }) !==
          this.synchronousLevel ||
        !durable(this.journalMode, this.synchronousLevel) ||
        this.db.prepare<[], { n: number }>(
          "SELECT count(*) AS n FROM sqlite_temp_master").get()?.n !== 0 ||
        databases.length < 1 || databases.length > 2 ||
        databases[0]?.name !== "main" ||
        realpathSync(databases[0].file) !== this.canonicalPath ||
        databases.slice(1).some((row) => row.name !== "temp" || row.file !== ""))
        throw new IncompatibleNonDayDraftLedger();
      assertManagedSchema(this.db);
    } catch { throw new IncompatibleNonDayDraftLedger(); }
  }
}

function asStagingIntent(row: Intent): ManagedStagingIntent {
  return { householdId: row.householdId, accountId: row.accountId,
    sessionId: row.sessionId, intentId: row.intentId,
    attemptId: row.attemptId, blobId: row.blobId,
    plaintextBytes: row.plaintextBytes, chunkCount: row.chunkCount };
}

function sameIntent(expected: ManagedStagingIntent, row: Intent): boolean {
  const actual = asStagingIntent(row);
  return Object.keys(actual).every((key) =>
    actual[key as keyof ManagedStagingIntent] ===
      expected[key as keyof ManagedStagingIntent]);
}

function validChunks(chunks: readonly VerifiedUploadChunkRow[],
  plaintextBytes: number): boolean {
  const objects = new Set<string>();
  const nonces = new Set<string>();
  for (const [index, chunk] of chunks.entries()) {
    if (!chunk || chunk.index !== index || !Buffer.isBuffer(chunk.iv) ||
      chunk.iv.length !== 12 || nonces.has(chunk.iv.toString("hex")) ||
      !ID.test(chunk.storageObjectId) || objects.has(chunk.storageObjectId) ||
      !Buffer.isBuffer(chunk.ciphertextSha256) ||
      chunk.ciphertextSha256.length !== 32 ||
      chunk.ciphertextBytes !== 16 + Math.max(0, Math.min(
        MANAGED_VAULT_CHUNK_BYTES,
        plaintextBytes - index * MANAGED_VAULT_CHUNK_BYTES))) return false;
    objects.add(chunk.storageObjectId);
    nonces.add(chunk.iv.toString("hex"));
  }
  return true;
}

function privateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new IncompatibleNonDayDraftLedger();
}

function privateFile(path: string, required: boolean): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new IncompatibleNonDayDraftLedger();
  } catch (error) {
    if (!required && typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT") return;
    throw new IncompatibleNonDayDraftLedger();
  }
}

function durable(mode: unknown, sync: unknown): boolean {
  return (mode === "wal" && (sync === 2 || sync === 3)) ||
    (mode === "delete" && sync === 3);
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      error.code === "SQLITE_CONSTRAINT_UNIQUE");
}

function isConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT");
}
