import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import type { PendingDraftPairActionContextV1 } from "@adeno/contracts";
import type Database from "better-sqlite3";

import { verifyCsrfToken } from "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";
import { PendingDraftPairActionDenied, verifyPendingDraftPairAction,
  type SignedPendingDraftPairActionRow } from
  "./verifyPendingDraftPairAction.js";

const TOKEN_HASH = /^[0-9a-f]{64}$/u;
const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
type Auth = { householdId: string; accountId: string; sessionId: string;
  deviceId: string; csrfSecret: Buffer; signingPublicKey: Buffer };
type Reservation = { id: string; profileId: string; scopeId: string;
  keyId: string; epoch: number; sessionId: string; writerDeviceId: string;
  contentIntentId: string; metadataIntentId: string;
  contentBlobId: string; metadataBlobId: string; expiresAt: number };
type Heads = { keyCommitment: Buffer; activeKeyHead: Buffer;
  grantHead: Buffer };
type Blob = { intentId: string; role: "content" | "metadata";
  blobId: string; objectId: string; profileId: string; scopeId: string;
  keyId: string; epoch: number; writerDeviceId: string;
  sessionId: string; purpose: string; aadRevision: number;
  wireVersion: number; consumedAt: number; wireSha256: Buffer;
  wireBytes: number; committedAt: number; blobRole: string;
  blobObjectId: string; blobPurpose: string };
type Prior = { counter: number; actionSha256: Buffer };
type Existing = { profileId: string; scopeId: string; keyId: string;
  epoch: number; contentBlobId: string; metadataBlobId: string;
  authorDeviceId: string; sessionId: string; authorCounter: number;
  pairSha256: Buffer; pairedAt: number; actionSha256: Buffer;
  signature: Buffer; previousActionSha256: Buffer | null;
  payloadSha256: Buffer; actionKind: string; createdAt: number };

export class ManagedPendingDraftPairDenied extends Error {
  constructor() { super("The signed pending draft pair was denied."); }
}
export class ManagedPendingDraftPairUnavailable extends Error {
  constructor() { super("The signed pending draft pair is unavailable."); }
}

/**
 * UNMOUNTED v10 writer: two already-committed ciphertexts become one pending
 * review unit, never an approved day. It must receive the exact canonical
 * claims because v10 persists only their digest/signature, not the payload.
 * It does not decrypt metadata, prove current disk health or solve abandoned
 * leases. Do not mount without schema/device guards, payload retention and
 * the remaining managed launch gates.
 */
export function submitPendingDraftPair(db: Database.Database, input: {
  tokenSha256: string;
  csrfToken: string;
  context: PendingDraftPairActionContextV1;
  action: SignedPendingDraftPairActionRow;
}): { status: "pending"; reservationId: string; pairSha256: string } {
  try {
    if (typeof input.tokenSha256 !== "string" ||
      !TOKEN_HASH.test(input.tokenSha256) ||
      typeof input.csrfToken !== "string" ||
      input.csrfToken.length > 256)
      throw new ManagedPendingDraftPairDenied();
    const context = { ...input.context };
    const action = { ...input.action,
      signature: copySignature(input.action.signature) };
    if (!ID.test(context.reservationId) ||
      !HASH.test(action.payloadSha256) ||
      !HASH.test(action.actionSha256) ||
      !safeSqliteInteger(context.authorCounter) ||
      !safeSqliteInteger(context.pairedAt))
      throw new ManagedPendingDraftPairDenied();
    const submit = db.transaction(() => {
      assertOperational(db);
      const auth = db.prepare<[Buffer], Auth>(
        "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
        "s.id AS sessionId, binding.device_id AS deviceId, " +
        "s.csrf_secret AS csrfSecret, d.signing_public_key AS signingPublicKey " +
        "FROM managed_sessions s " +
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
      ).get(Buffer.from(input.tokenSha256, "hex"));
      if (!auth || !Buffer.isBuffer(auth.csrfSecret) ||
        auth.csrfSecret.length !== 32 ||
        !Buffer.isBuffer(auth.signingPublicKey) ||
        auth.signingPublicKey.length !== 32 ||
        !verifyCsrfToken(input.csrfToken, auth.sessionId, auth.csrfSecret) ||
        auth.householdId !== context.householdId ||
        auth.sessionId !== context.sessionId ||
        auth.deviceId !== context.authorDeviceId)
        throw new ManagedPendingDraftPairDenied();
      const reservation = db.prepare<[string, string], Reservation>(
        "SELECT id, profile_id AS profileId, scope_id AS scopeId, " +
        "key_id AS keyId, epoch, session_id AS sessionId, " +
        "writer_device_id AS writerDeviceId, " +
        "content_intent_id AS contentIntentId, " +
        "metadata_intent_id AS metadataIntentId, " +
        "content_blob_id AS contentBlobId, " +
        "metadata_blob_id AS metadataBlobId, expires_at AS expiresAt " +
        "FROM managed_draft_reservations WHERE household_id=? AND id=?",
      ).get(auth.householdId, context.reservationId);
      if (!reservation || reservation.sessionId !== auth.sessionId ||
        reservation.writerDeviceId !== auth.deviceId)
        throw new ManagedPendingDraftPairDenied();
      const existing = db.prepare<[string, string], Existing>(
        "SELECT pair.profile_id AS profileId, pair.scope_id AS scopeId, " +
        "pair.key_id AS keyId, pair.epoch, " +
        "pair.content_blob_id AS contentBlobId, " +
        "pair.metadata_blob_id AS metadataBlobId, " +
        "pair.author_device_id AS authorDeviceId, " +
        "pair.session_id AS sessionId, " +
        "pair.author_counter AS authorCounter, " +
        "pair.pair_sha256 AS pairSha256, pair.paired_at AS pairedAt, " +
        "action.action_sha256 AS actionSha256, action.signature, " +
        "action.previous_action_sha256 AS previousActionSha256, " +
        "action.payload_sha256 AS payloadSha256, " +
        "action.action_kind AS actionKind, " +
        "action.created_at AS createdAt " +
        "FROM managed_pending_draft_pairs pair " +
        "JOIN managed_signed_actions action " +
        "ON action.household_id=pair.household_id " +
        "AND action.device_id=pair.author_device_id " +
        "AND action.counter=pair.author_counter " +
        "WHERE pair.household_id=? AND pair.reservation_id=?",
      ).get(auth.householdId, reservation.id);
      if (existing) {
        if (existing.profileId !== reservation.profileId ||
          existing.scopeId !== reservation.scopeId ||
          existing.keyId !== reservation.keyId ||
          existing.epoch !== reservation.epoch ||
          existing.contentBlobId !== reservation.contentBlobId ||
          existing.metadataBlobId !== reservation.metadataBlobId ||
          existing.authorDeviceId !== auth.deviceId ||
          existing.sessionId !== auth.sessionId ||
          existing.authorCounter !== Number(context.authorCounter) ||
          existing.pairedAt !== Number(context.pairedAt) ||
          existing.createdAt !== Number(context.pairedAt) ||
          existing.actionKind !== "review" ||
          !sameDigest(existing.pairSha256, action.payloadSha256) ||
          !sameDigest(existing.payloadSha256, action.payloadSha256) ||
          !sameDigest(existing.actionSha256, action.actionSha256) ||
          !Buffer.isBuffer(existing.signature) ||
          !existing.signature.equals(Buffer.from(action.signature)) ||
          (existing.previousActionSha256 === null ? null :
            existing.previousActionSha256.toString("hex")) !==
              context.previousActionSha256)
          throw new ManagedPendingDraftPairDenied();
        // The immutable pair/action are the admission record. Re-verify
        // their exact signed preimage without imposing today's reservation
        // expiry or mutable key/grant heads on this readback.
        verifyPendingDraftPairAction({ context,
          pairSha256: action.payloadSha256, action,
          current: { ...context,
            householdId: auth.householdId,
            careProfileId: reservation.profileId,
            opaqueDraftScopeId: reservation.scopeId,
            keyId: reservation.keyId,
            reservationId: reservation.id,
            contentIntentId: reservation.contentIntentId,
            metadataIntentId: reservation.metadataIntentId,
            contentBlobId: reservation.contentBlobId,
            metadataBlobId: reservation.metadataBlobId,
            authorDeviceId: auth.deviceId,
            sessionId: auth.sessionId,
            keyEpoch: reservation.epoch },
          enrolledAuthorSigningPublicKey: auth.signingPublicKey,
          expectedCounter: context.authorCounter,
          expectedPreviousActionSha256: context.previousActionSha256,
          authenticatedSessionId: auth.sessionId,
          authenticatedAuthorDeviceId: auth.deviceId,
          nowUnixSeconds: context.pairedAt });
        return { status: "pending" as const,
          reservationId: reservation.id,
          pairSha256: action.payloadSha256 };
      }
      const now = db.prepare<[], { now: number }>(
        "SELECT unixepoch('now') AS now").get()?.now;
      if (!Number.isSafeInteger(now) ||
        reservation.expiresAt <= now! ||
        reservation.sessionId !== auth.sessionId ||
        reservation.writerDeviceId !== auth.deviceId)
        throw new ManagedPendingDraftPairDenied();
      const heads = db.prepare<[
        string, string, string, string, number, string
      ], Heads>(
        "SELECT k.key_commitment AS keyCommitment, " +
        "current_key.head_sha256 AS activeKeyHead, " +
        "g.head_sha256 AS grantHead FROM managed_scopes sc " +
        "JOIN managed_profiles p ON p.household_id=sc.household_id " +
        "AND p.id=sc.profile_id " +
        "JOIN managed_current_scope_keys current_key " +
        "ON current_key.household_id=sc.household_id " +
        "AND current_key.profile_id=sc.profile_id " +
        "AND current_key.scope_id=sc.id " +
        "JOIN managed_key_identities k ON k.household_id=sc.household_id " +
        "AND k.profile_id=sc.profile_id AND k.scope_id=sc.id " +
        "AND k.key_id=current_key.key_id AND k.epoch=current_key.epoch " +
        "JOIN managed_grant_heads g ON g.household_id=sc.household_id " +
        "AND g.profile_id=sc.profile_id AND g.scope_id=sc.id " +
        "WHERE sc.household_id=? AND sc.profile_id=? AND sc.id=? " +
        "AND k.key_id=? AND k.epoch=? AND g.subject_device_id=? " +
        "AND sc.kind='draft' AND sc.state='active' " +
        "AND p.state='active' AND k.purpose='draft' " +
        "AND (g.capability_mask & 2)=2 " +
        "AND current_key.head_sha256 IS NOT NULL " +
        "AND g.head_sha256 IS NOT NULL",
      ).get(auth.householdId, reservation.profileId, reservation.scopeId,
        reservation.keyId, reservation.epoch, auth.deviceId);
      if (!heads || ![heads.keyCommitment, heads.activeKeyHead,
        heads.grantHead].every((value) => Buffer.isBuffer(value) &&
        value.length === 32)) throw new ManagedPendingDraftPairDenied();
      const blobs = db.prepare<[string, string], Blob>(
        "SELECT i.id AS intentId, i.role, i.blob_id AS blobId, " +
        "i.object_id AS objectId, i.profile_id AS profileId, " +
        "i.scope_id AS scopeId, i.key_id AS keyId, i.epoch, " +
        "i.writer_device_id AS writerDeviceId, " +
        "i.session_id AS sessionId, i.purpose, " +
        "i.aad_revision AS aadRevision, i.wire_version AS wireVersion, " +
        "i.consumed_at AS consumedAt, " +
        "b.wire_sha256 AS wireSha256, b.wire_bytes AS wireBytes, " +
        "b.committed_at AS committedAt, b.role AS blobRole, " +
        "b.object_id AS blobObjectId, b.purpose AS blobPurpose " +
        "FROM managed_non_day_upload_intents i " +
        "JOIN managed_non_day_committed_blobs b " +
        "ON b.household_id=i.household_id AND b.intent_id=i.id " +
        "AND b.blob_id=i.blob_id " +
        "WHERE i.household_id=? AND i.draft_reservation_id=? " +
        "AND i.purpose='draft' ORDER BY i.role",
      ).all(auth.householdId, reservation.id);
      if (blobs.length !== 2) throw new ManagedPendingDraftPairDenied();
      const content = blobs.find((row) => row.role === "content");
      const metadata = blobs.find((row) => row.role === "metadata");
      if (!content || !metadata || content.intentId !==
        reservation.contentIntentId || metadata.intentId !==
        reservation.metadataIntentId || content.blobId !==
        reservation.contentBlobId || metadata.blobId !==
        reservation.metadataBlobId || content.objectId ===
        metadata.objectId || blobs.some((row) =>
        row.profileId !== reservation.profileId ||
        row.scopeId !== reservation.scopeId ||
        row.keyId !== reservation.keyId ||
        row.epoch !== reservation.epoch ||
        row.sessionId !== auth.sessionId ||
        row.writerDeviceId !== auth.deviceId ||
        row.purpose !== "draft" || row.blobPurpose !== "draft" ||
        row.blobRole !== row.role ||
        row.objectId !== row.blobObjectId ||
        row.aadRevision !== 1 || row.wireVersion !== 2 ||
        row.consumedAt === null ||
        row.committedAt > reservation.expiresAt ||
        !Buffer.isBuffer(row.wireSha256) ||
        row.wireSha256.length !== 32 ||
        !Number.isSafeInteger(row.wireBytes) || row.wireBytes < 66))
        throw new ManagedPendingDraftPairDenied();
      const current = {
        householdId: auth.householdId,
        careProfileId: reservation.profileId,
        opaqueDraftScopeId: reservation.scopeId,
        keyId: reservation.keyId,
        reservationId: reservation.id,
        contentIntentId: reservation.contentIntentId,
        metadataIntentId: reservation.metadataIntentId,
        contentBlobId: reservation.contentBlobId,
        metadataBlobId: reservation.metadataBlobId,
        contentObjectId: content.objectId,
        metadataObjectId: metadata.objectId,
        authorDeviceId: auth.deviceId,
        sessionId: auth.sessionId,
        keyEpoch: reservation.epoch,
        contentWireBytes: content.wireBytes,
        metadataWireBytes: metadata.wireBytes,
        keyCommitmentSha256: heads.keyCommitment.toString("hex"),
        activeKeyHeadSha256: heads.activeKeyHead.toString("hex"),
        grantHeadSha256: heads.grantHead.toString("hex"),
        contentWireSha256: content.wireSha256.toString("hex"),
        metadataWireSha256: metadata.wireSha256.toString("hex"),
      };
      const prior = db.prepare<[string, string], Prior>(
        "SELECT counter, action_sha256 AS actionSha256 " +
        "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
        "ORDER BY counter DESC LIMIT 1",
      ).get(auth.householdId, auth.deviceId);
      if (prior && (!Number.isSafeInteger(prior.counter) ||
        prior.counter < 1 || !Buffer.isBuffer(prior.actionSha256) ||
        prior.actionSha256.length !== 32))
        throw new ManagedPendingDraftPairDenied();
      const expectedCounter = prior ? BigInt(prior.counter) + 1n : 1n;
      const expectedPrevious = prior?.actionSha256.toString("hex") ?? null;
      verifyPendingDraftPairAction({ context,
        pairSha256: action.payloadSha256, action, current,
        enrolledAuthorSigningPublicKey: auth.signingPublicKey,
        expectedCounter, expectedPreviousActionSha256: expectedPrevious,
        authenticatedSessionId: auth.sessionId,
        authenticatedAuthorDeviceId: auth.deviceId,
        nowUnixSeconds: BigInt(now!) });
      db.prepare(
        "INSERT INTO managed_signed_actions " +
        "(household_id,device_id,counter,action_kind,payload_sha256," +
        "previous_action_sha256,action_sha256,signature,created_at) " +
        "VALUES (?,?,?,'review',?,?,?,?,?)",
      ).run(auth.householdId, auth.deviceId, Number(context.authorCounter),
        Buffer.from(action.payloadSha256, "hex"),
        action.previousActionSha256 === null ? null :
          Buffer.from(action.previousActionSha256, "hex"),
        Buffer.from(action.actionSha256, "hex"), Buffer.from(action.signature),
        Number(context.pairedAt));
      db.prepare(
        "INSERT INTO managed_pending_draft_pairs " +
        "(household_id,reservation_id,profile_id,scope_id,key_id,epoch," +
        "content_blob_id,metadata_blob_id,author_device_id,session_id," +
        "author_counter,pair_sha256,paired_at) VALUES " +
        "(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(auth.householdId, reservation.id, reservation.profileId,
        reservation.scopeId, reservation.keyId, reservation.epoch,
        reservation.contentBlobId, reservation.metadataBlobId,
        auth.deviceId, auth.sessionId, Number(context.authorCounter),
        Buffer.from(action.payloadSha256, "hex"), Number(context.pairedAt));
      return { status: "pending" as const,
        reservationId: reservation.id,
        pairSha256: action.payloadSha256 };
    });
    return submit.immediate();
  } catch (error) {
    if (error instanceof ManagedPendingDraftPairDenied ||
      error instanceof PendingDraftPairActionDenied ||
      (typeof error === "object" && error !== null &&
        "code" in error && typeof error.code === "string" &&
        error.code.startsWith("SQLITE_CONSTRAINT")))
      throw new ManagedPendingDraftPairDenied();
    // Busy, I/O and unexpected failures may have an ambiguous outcome.
    // The caller must retry the exact signed request, never mint a new ID.
    throw new ManagedPendingDraftPairUnavailable();
  }
}

function copySignature(value: Uint8Array): Uint8Array {
  if (!ArrayBuffer.isView(value) ||
    Object.prototype.toString.call(value) !== "[object Uint8Array]" ||
    value.byteLength !== 64) throw new ManagedPendingDraftPairDenied();
  return Uint8Array.from(value);
}

function safeSqliteInteger(value: unknown): boolean {
  return typeof value === "bigint" && value > 0n &&
    value <= BigInt(Number.MAX_SAFE_INTEGER);
}

function sameDigest(value: Buffer, hex: string): boolean {
  return Buffer.isBuffer(value) && value.length === 32 &&
    value.toString("hex") === hex;
}

function assertOperational(db: Database.Database): void {
  try {
    const path = db.name;
    if (typeof path !== "string" || !isAbsolute(path))
      throw new ManagedPendingDraftPairDenied();
    const file = lstatSync(path);
    const directory = lstatSync(dirname(path));
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 || !directory.isDirectory() ||
      directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      (process.getuid !== undefined &&
        (file.uid !== process.getuid() ||
          directory.uid !== process.getuid())) ||
      db.readonly || db.pragma("query_only", { simple: true }) !== 0 ||
      db.pragma("foreign_keys", { simple: true }) !== 1 ||
      db.pragma("trusted_schema", { simple: true }) !== 0)
      throw new ManagedPendingDraftPairDenied();
    privateOptionalSidecar(`${path}-wal`);
    privateOptionalSidecar(`${path}-shm`);
    const mode = db.pragma("main.journal_mode", { simple: true });
    const sync = db.pragma("main.synchronous", { simple: true });
    if (!((mode === "wal" && (sync === 2 || sync === 3)) ||
      (mode === "delete" && sync === 3)))
      throw new ManagedPendingDraftPairDenied();
    const databases = db.prepare<[], { name: string; file: string }>(
      "PRAGMA database_list").all();
    if (databases.length < 1 || databases.length > 2 ||
      databases[0]?.name !== "main" ||
      realpathSync(databases[0].file) !== realpathSync(path) ||
      databases.slice(1).some((row) => row.name !== "temp" || row.file !== "") ||
      db.prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM sqlite_temp_master").get()?.n !== 0)
      throw new ManagedPendingDraftPairDenied();
    assertManagedSchema(db);
  } catch (error) {
    if (error instanceof ManagedPendingDraftPairDenied) throw error;
    throw new ManagedPendingDraftPairUnavailable();
  }
}

function privateOptionalSidecar(path: string): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new ManagedPendingDraftPairDenied();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT") return;
    throw error;
  }
}
