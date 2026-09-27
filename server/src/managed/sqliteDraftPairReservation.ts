import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { MANAGED_VAULT_CHUNK_BYTES } from "@adeno/contracts";
import type Database from "better-sqlite3";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";

const ID = /^[0-9a-f]{32}$/u;
const TOKEN_HASH = /^[0-9a-f]{64}$/u;
const MAX_CONTENT_BYTES = 16 * MANAGED_VAULT_CHUNK_BYTES;
const MAX_METADATA_BYTES = 16 * 1024;
const MIN_PAIR_WIRE_BYTES = 132;
const MAX_DEVICE_RESERVATIONS_PER_TEN_MINUTES = 8;
const MAX_FAMILY_RESERVATIONS_PER_DAY = 128;

type Caller = { tokenSha256: string; csrfToken: string };
type Session = { householdId: string; accountId: string;
  sessionId: string; deviceId: string; csrfSecret: Buffer };
type Reservation = { householdId: string; id: string; profileId: string;
  scopeId: string; keyId: string; epoch: number; writerDeviceId: string;
  sessionId: string; contentIntentId: string; metadataIntentId: string;
  contentBlobId: string; metadataBlobId: string; expiresAt: number };
type Intent = { id: string; role: "content" | "metadata";
  plaintextBytes: number; chunkCount: number };

export class ManagedDraftPairDenied extends Error {
  constructor() {
    super("The encrypted draft pair could not be reserved.");
    this.name = "ManagedDraftPairDenied";
  }
}

/**
 * Unmounted managed-v10 draft intake preflight. The caller owns an already
 * opened, private, approved-schema SQLite connection. This service creates no
 * database, applies no migration, reads no plaintext and cannot upload files.
 * It only issues both IDs before device encryption, binds both encrypted
 * intents, and opens both quota-charged leases atomically before object writes.
 * V10 has no safe release for abandoned leases or immutable ID claims. Do not
 * mount this writer until a separately approved lifecycle/reconciliation path
 * is implemented and tested against storage, crashes and quota contention.
 */
export class SqliteDraftPairReservation {
  constructor(private readonly db: Database.Database,
    private readonly maxFamilyBytes: number,
    private readonly maxGlobalBytes: number) {
    if (!Number.isSafeInteger(maxFamilyBytes) ||
      maxFamilyBytes < MIN_PAIR_WIRE_BYTES ||
      !Number.isSafeInteger(maxGlobalBytes) ||
      maxGlobalBytes < MIN_PAIR_WIRE_BYTES)
      throw new ManagedDraftPairDenied();
    this.assertOperational();
  }

  reserve(input: Caller & { profileId: string; scopeId: string;
    keyId: string; epoch: number }) {
    return this.run(() => {
      if (![input.profileId, input.scopeId, input.keyId].every(validId) ||
        !Number.isSafeInteger(input.epoch) || input.epoch < 1 ||
        input.epoch > 0xffffffff) throw new ManagedDraftPairDenied();
      const session = this.requireSession(input);
      this.requireDraftScope(session, input.profileId, input.scopeId,
        input.keyId, input.epoch);
      const now = this.now();
      const recent = this.db.prepare<[string, number, number, string], {
        deviceCount: number; familyCount: number }>(
        "SELECT count(*) FILTER (WHERE writer_device_id = ? " +
        "AND created_at > ?) AS deviceCount, count(*) FILTER " +
        "(WHERE created_at > ?) AS familyCount " +
        "FROM managed_draft_reservations WHERE household_id = ?",
      ).get(session.deviceId, now - 600, now - 86400,
        session.householdId);
      if (!recent || recent.deviceCount >=
        MAX_DEVICE_RESERVATIONS_PER_TEN_MINUTES ||
        recent.familyCount >= MAX_FAMILY_RESERVATIONS_PER_DAY)
        throw new ManagedDraftPairDenied();
      const result = { reservationId: newId(), contentIntentId: newId(),
        metadataIntentId: newId(), contentBlobId: newId(),
        metadataBlobId: newId(), expiresAt: now + 600 };
      this.db.prepare(
        "INSERT INTO managed_draft_reservations " +
        "(household_id,id,profile_id,scope_id,key_id,epoch,writer_device_id," +
        "session_id,content_intent_id,metadata_intent_id,content_blob_id," +
        "metadata_blob_id,created_at,expires_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(session.householdId, result.reservationId, input.profileId,
        input.scopeId, input.keyId, input.epoch, session.deviceId,
        session.sessionId, result.contentIntentId, result.metadataIntentId,
        result.contentBlobId, result.metadataBlobId, now, result.expiresAt);
      return result;
    });
  }

  bindIntents(input: Caller & { reservationId: string;
    content: { objectId: string; plaintextBytes: number };
    metadata: { objectId: string; plaintextBytes: number } }) {
    return this.run(() => {
      if (!validId(input.reservationId) ||
        !validId(input.content?.objectId) ||
        !validId(input.metadata?.objectId) ||
        input.content.objectId === input.metadata.objectId ||
        !validBytes(input.content.plaintextBytes, MAX_CONTENT_BYTES) ||
        !validBytes(input.metadata.plaintextBytes, MAX_METADATA_BYTES))
        throw new ManagedDraftPairDenied();
      const session = this.requireSession(input);
      const reservation = this.requireReservation(session, input.reservationId);
      const now = this.now();
      const insert = this.db.prepare(
        "INSERT INTO managed_non_day_upload_intents " +
        "(household_id,id,profile_id,scope_id,key_id,epoch,purpose,role," +
        "draft_reservation_id,object_id,aad_revision,wire_version,blob_id," +
        "writer_device_id,session_id,plaintext_bytes,chunk_count,created_at," +
        "expires_at) VALUES (?,?,?,?,?,?,'draft',?,?,?,1,2,?,?,?,?,?,?,?)",
      );
      for (const item of [
        { role: "content", id: reservation.contentIntentId,
          blobId: reservation.contentBlobId, ...input.content },
        { role: "metadata", id: reservation.metadataIntentId,
          blobId: reservation.metadataBlobId, ...input.metadata },
      ] as const) {
        insert.run(reservation.householdId, item.id, reservation.profileId,
          reservation.scopeId, reservation.keyId, reservation.epoch,
          item.role, reservation.id, item.objectId, item.blobId,
          session.deviceId, session.sessionId, item.plaintextBytes,
          chunks(item.plaintextBytes), now, reservation.expiresAt);
      }
      return { contentIntentId: reservation.contentIntentId,
        metadataIntentId: reservation.metadataIntentId,
        contentBlobId: reservation.contentBlobId,
        metadataBlobId: reservation.metadataBlobId,
        expiresAt: reservation.expiresAt };
    });
  }

  openPairedLeases(input: Caller & { reservationId: string }) {
    return this.run(() => {
      if (!validId(input.reservationId)) throw new ManagedDraftPairDenied();
      const session = this.requireSession(input);
      const reservation = this.requireReservation(session, input.reservationId);
      const intents = this.db.prepare<[string, string], Intent>(
        "SELECT id, role, plaintext_bytes AS plaintextBytes, " +
        "chunk_count AS chunkCount FROM managed_non_day_upload_intents " +
        "WHERE household_id = ? AND draft_reservation_id = ? " +
        "AND purpose = 'draft' AND consumed_at IS NULL " +
        "AND expires_at > unixepoch('now')",
      ).all(session.householdId, reservation.id);
      if (intents.length !== 2 ||
        !intents.some((row) => row.role === "content" &&
          row.id === reservation.contentIntentId) ||
        !intents.some((row) => row.role === "metadata" &&
          row.id === reservation.metadataIntentId) ||
        intents.some((row) => !Number.isSafeInteger(row.plaintextBytes) ||
          !Number.isSafeInteger(row.chunkCount)))
        throw new ManagedDraftPairDenied();
      const total = intents.reduce((sum, row) => sum + wireBytes(row), 0);
      const usage = this.db.prepare<[string], { familyBytes: number;
        globalBytes: number }>(
        "SELECT COALESCE(SUM(CASE WHEN household_id = ? THEN bytes ELSE 0 END),0) " +
        "AS familyBytes, COALESCE(SUM(bytes),0) AS globalBytes " +
        "FROM managed_wire_occupancy",
      ).get(session.householdId);
      if (!usage || !Number.isSafeInteger(usage.familyBytes) ||
        !Number.isSafeInteger(usage.globalBytes) ||
        usage.familyBytes > this.maxFamilyBytes - total ||
        usage.globalBytes > this.maxGlobalBytes - total)
        throw new ManagedDraftPairDenied();
      const now = this.now();
      const attempts = { content: newId(), metadata: newId() };
      const insert = this.db.prepare(
        "INSERT INTO managed_non_day_staging_leases " +
        "(household_id,intent_id,attempt_id,reserved_bytes,opened_at) " +
        "VALUES (?,?,?,?,?)",
      );
      for (const intent of intents) {
        insert.run(session.householdId, intent.id, attempts[intent.role],
          wireBytes(intent), now);
      }
      return { contentAttemptId: attempts.content,
        metadataAttemptId: attempts.metadata, reservedBytes: total };
    });
  }

  private run<T>(action: () => T): T {
    try {
      return this.db.transaction(() => {
        this.assertOperational();
        return action();
      }).immediate();
    } catch { throw new ManagedDraftPairDenied(); }
  }

  private requireSession(input: Caller): Session {
    if (typeof input.tokenSha256 !== "string" ||
      !TOKEN_HASH.test(input.tokenSha256) ||
      typeof input.csrfToken !== "string" || input.csrfToken.length > 256)
      throw new ManagedDraftPairDenied();
    const row = this.db.prepare<[Buffer], Session>(
      "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
      "s.id AS sessionId, binding.device_id AS deviceId, " +
      "s.csrf_secret AS csrfSecret FROM managed_sessions s " +
      "JOIN managed_accounts a ON a.id = s.account_id " +
      "JOIN managed_memberships m ON m.household_id = s.household_id " +
      "AND m.account_id = s.account_id " +
      "JOIN managed_families f ON f.id = s.household_id " +
      "JOIN managed_session_device_bindings binding " +
      "ON binding.household_id = s.household_id " +
      "AND binding.account_id = s.account_id AND binding.session_id = s.id " +
      "JOIN managed_devices d ON d.household_id = binding.household_id " +
      "AND d.account_id = binding.account_id AND d.id = binding.device_id " +
      "WHERE s.token_sha256 = ? AND s.revoked_at IS NULL " +
      "AND s.expires_at > unixepoch('now') " +
      "AND s.account_auth_version = a.auth_version " +
      "AND s.membership_auth_version = m.auth_version " +
      "AND a.state = 'active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state = 'active' AND f.state = 'active' AND d.state = 'active'",
    ).get(Buffer.from(input.tokenSha256, "hex"));
    if (!row || !Buffer.isBuffer(row.csrfSecret) ||
      row.csrfSecret.length !== 32 ||
      !verifyCsrfToken(input.csrfToken, row.sessionId, row.csrfSecret))
      throw new ManagedDraftPairDenied();
    return row;
  }

  private requireDraftScope(session: Session, profileId: string,
    scopeId: string, keyId: string, epoch: number): void {
    const row = this.db.prepare<[
      string, string, string, string, number, string
    ], { allowed: number }>(
      "SELECT 1 AS allowed FROM managed_scopes sc " +
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
      "WHERE sc.household_id = ? AND sc.profile_id = ? AND sc.id = ? " +
      "AND sc.kind = 'draft' AND sc.state = 'active' " +
      "AND p.state = 'active' AND k.purpose = 'draft' " +
      "AND k.key_id = ? AND k.epoch = ? " +
      "AND g.subject_device_id = ? AND (g.capability_mask & 2) = 2",
    ).get(session.householdId, profileId, scopeId, keyId, epoch,
      session.deviceId);
    if (!row) throw new ManagedDraftPairDenied();
  }

  private requireReservation(session: Session, reservationId: string):
    Reservation {
    const row = this.db.prepare<[
      string, string, string, string
    ], Reservation>(
      "SELECT household_id AS householdId, id, profile_id AS profileId, " +
      "scope_id AS scopeId, key_id AS keyId, epoch, " +
      "writer_device_id AS writerDeviceId, session_id AS sessionId, " +
      "content_intent_id AS contentIntentId, " +
      "metadata_intent_id AS metadataIntentId, " +
      "content_blob_id AS contentBlobId, " +
      "metadata_blob_id AS metadataBlobId, expires_at AS expiresAt " +
      "FROM managed_draft_reservations " +
      "WHERE household_id = ? AND id = ? AND session_id = ? " +
      "AND writer_device_id = ? AND expires_at > unixepoch('now')",
    ).get(session.householdId, reservationId, session.sessionId,
      session.deviceId);
    if (!row) throw new ManagedDraftPairDenied();
    this.requireDraftScope(session, row.profileId, row.scopeId,
      row.keyId, row.epoch);
    return row;
  }

  private now(): number {
    const now = this.db.prepare<[], { now: number }>(
      "SELECT unixepoch('now') AS now").get()?.now;
    if (!Number.isSafeInteger(now) || now! <= 0)
      throw new ManagedDraftPairDenied();
    return now!;
  }

  private assertOperational(): void {
    const path = this.db?.name;
    if (typeof path !== "string" || !isAbsolute(path) ||
      this.db.readonly ||
      this.db.pragma("query_only", { simple: true }) !== 0 ||
      this.db.prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM sqlite_temp_master").get()?.n !== 0)
      throw new ManagedDraftPairDenied();
    privateFile(path);
    privateDirectory(dirname(path));
    privateOptionalFile(`${path}-wal`);
    privateOptionalFile(`${path}-shm`);
    const databases = this.db.prepare<[], { name: string; file: string }>(
      "PRAGMA database_list").all();
    if (databases.length < 1 || databases.length > 2 ||
      databases[0]?.name !== "main" ||
      realpathSync(databases[0].file) !== realpathSync(path) ||
      databases.slice(1).some((row) => row.name !== "temp" || row.file !== ""))
      throw new ManagedDraftPairDenied();
    const mode = this.db.pragma("main.journal_mode", { simple: true });
    const sync = this.db.pragma("main.synchronous", { simple: true });
    if (!((mode === "wal" && (sync === 2 || sync === 3)) ||
      (mode === "delete" && sync === 3)))
      throw new ManagedDraftPairDenied();
    assertManagedSchema(this.db);
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validBytes(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= maximum;
}

function chunks(plaintextBytes: number): number {
  return Math.max(1, Math.ceil(plaintextBytes / MANAGED_VAULT_CHUNK_BYTES));
}

function wireBytes(intent: Intent): number {
  return 33 + intent.plaintextBytes + 32 * intent.chunkCount;
}

function newId(): string { return randomBytes(16).toString("hex"); }

function privateFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new ManagedDraftPairDenied();
}

function privateOptionalFile(path: string): void {
  try { privateFile(path); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT") return;
    throw error;
  }
}

function privateDirectory(path: string): void {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new ManagedDraftPairDenied();
}
