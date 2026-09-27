import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { decodeManagedVaultBlobV2, encodeManagedVaultBlobV2 } from
  "@adeno/contracts";
import Database from "better-sqlite3";

import { issueCsrfToken, issueSessionToken } from
  "../dist/auth/cookieSession.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { ManagedDraftPairDenied, SqliteDraftPairReservation } from
  "../dist/managed/sqliteDraftPairReservation.js";
import { encryptManagedVaultBlobV2 } from
  "../../web/src/crypto/managedVaultV2.ts";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

// Only copy the exact already-approved empty fictional v10 DB. No migration
// is run; neither the source nor any production/community DB is writable here.
const APPROVED_DIRECTORY = "adeno-fictional-managed-fJAg4s";
const APPROVED_EMPTY_SHA256 =
  "2c3ee411bc91d720ffe1586badf071abe9b2ce9e1225b35a4de49a64c5ceb027";
const sourcePath = process.argv[2];
assert.equal(process.env.ADENO_APPROVED_FICTIONAL_MIGRATION, "1");
assert.equal(process.env.NODE_ENV === "production", false);
assert.equal(Object.keys(process.env).some((name) => name.startsWith("RAILWAY_")), false);
assert.equal(typeof sourcePath, "string");
const sourceParent = realpathSync(dirname(sourcePath));
assert.equal(basename(sourcePath), "managed.sqlite3");
assert.equal(basename(sourceParent), APPROVED_DIRECTORY);
assert.equal(dirname(sourceParent), realpathSync(tmpdir()));
assert.equal(realpathSync(sourcePath), join(sourceParent, "managed.sqlite3"));
assert.equal(statSync(sourcePath).mode & 0o077, 0);
assert.equal(existsSync(`${sourcePath}-wal`), false);
assert.equal(existsSync(`${sourcePath}-shm`), false);
assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
  APPROVED_EMPTY_SHA256);

const root = await mkdtemp(join(tmpdir(), "adeno-fictional-draft-pair-"));
const dbPath = join(root, "managed.sqlite3");
await copyFile(sourcePath, dbPath);
await chmod(dbPath, 0o600);
const db = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
try {
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma("synchronous = EXTRA");
  assertManagedSchema(db);
  const weakConnection = new Database(dbPath, { fileMustExist: true });
  try {
    weakConnection.pragma("trusted_schema = OFF");
    weakConnection.pragma("synchronous = EXTRA");
    weakConnection.pragma("foreign_keys = OFF");
    assert.equal(weakConnection.pragma("foreign_keys", { simple: true }), 0);
    assert.throws(() => new SqliteDraftPairReservation(weakConnection,
      4096, 8192));
    weakConnection.pragma("foreign_keys = ON");
    weakConnection.pragma("trusted_schema = ON");
    assert.throws(() => new SqliteDraftPairReservation(weakConnection,
      4096, 8192));
  } finally { weakConnection.close(); }
  const now = Math.floor(Date.now() / 1000);
  const [alpha, beta] = db.transaction(() => [
    seedFictionalManagedFamily(db, "1", "2", now),
    seedFictionalManagedFamily(db, "6", "7", now,
      { intentByte: "c", blobByte: "d" }),
  ]).immediate();
  const alphaDraft = seedDraftScope(db, alpha, now);
  const betaDraft = seedDraftScope(db, beta, now);
  const service = new SqliteDraftPairReservation(db, 4096, 8192);
  const auth = (family) => ({ tokenSha256: family.tokenSha256,
    csrfToken: family.csrfToken });
  const reserve = (family, scope) => service.reserve({ ...auth(family),
    profileId: family.profileId, scopeId: scope.scopeId,
    keyId: scope.keyId, epoch: 1 });
  const alphaIds = reserve(alpha, alphaDraft);
  assert.equal(new Set(Object.values(alphaIds).filter((value) =>
    typeof value === "string")).size, 5);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_upload_id_claims " +
    "WHERE household_id=? AND lineage='draft_reserved'")
    .get(alpha.householdId).n, 4);
  assert.throws(() => service.reserve({ ...auth(alpha), csrfToken: "wrong",
    profileId: alpha.profileId, scopeId: alphaDraft.scopeId,
    keyId: alphaDraft.keyId, epoch: 1 }), ManagedDraftPairDenied);
  assert.throws(() => service.reserve({ ...auth(beta),
    profileId: alpha.profileId, scopeId: alphaDraft.scopeId,
    keyId: alphaDraft.keyId, epoch: 1 }), ManagedDraftPairDenied);
  const secondSession = seedSecondSession(db, alpha, now);
  const secondSessionPair = service.reserve({ ...secondSession,
    profileId: alpha.profileId, scopeId: alphaDraft.scopeId,
    keyId: alphaDraft.keyId, epoch: 1 });
  assert.notEqual(secondSessionPair.reservationId, alphaIds.reservationId);

  const marker = "FICTIONAL_DRAFT_NOTE_NOT_A_REAL_PERSON";
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]);
  const contentObjectId = randomBytes(16).toString("hex");
  const metadataObjectId = randomBytes(16).toString("hex");
  const draftScope = (objectId) => ({ householdId: alpha.householdId,
    careProfileId: alpha.profileId, opaqueScopeId: alphaDraft.scopeId,
    objectId, keyEpoch: 1, purpose: "review-draft", revision: 1 });
  const contentWire = encodeManagedVaultBlobV2(
    await encryptManagedVaultBlobV2(key, new TextEncoder().encode(marker),
      draftScope(contentObjectId), Buffer.from(alphaIds.contentBlobId, "hex")));
  const metadataWire = encodeManagedVaultBlobV2(
    await encryptManagedVaultBlobV2(key,
      new TextEncoder().encode(JSON.stringify({
        format: "fictional-draft-metadata", contentBlobId: alphaIds.contentBlobId,
      })), draftScope(metadataObjectId),
      Buffer.from(alphaIds.metadataBlobId, "hex")));
  const parts = { content: { objectId: contentObjectId,
    plaintextBytes: decodeManagedVaultBlobV2(contentWire).plaintextSize },
  metadata: { objectId: metadataObjectId,
    plaintextBytes: decodeManagedVaultBlobV2(metadataWire).plaintextSize } };
  assert.equal(Buffer.from(contentWire).includes(Buffer.from(marker)), false);
  assert.throws(() => service.bindIntents({ ...auth(beta),
    reservationId: alphaIds.reservationId, ...parts }),
  ManagedDraftPairDenied);
  assert.throws(() => service.bindIntents({ ...secondSession,
    reservationId: alphaIds.reservationId, ...parts }),
  ManagedDraftPairDenied);
  const bound = service.bindIntents({ ...auth(alpha),
    reservationId: alphaIds.reservationId, ...parts });
  assert.equal(bound.contentBlobId, alphaIds.contentBlobId);
  assert.equal(bound.metadataBlobId, alphaIds.metadataBlobId);
  assert.deepEqual(db.prepare("SELECT role FROM managed_non_day_upload_intents " +
    "WHERE household_id=? AND draft_reservation_id=? ORDER BY role")
    .all(alpha.householdId, alphaIds.reservationId).map((row) => row.role),
  ["content", "metadata"]);

  // A duplicate on the second insert must roll the first one back.
  const collision = reserve(alpha, alphaDraft);
  assert.throws(() => service.bindIntents({ ...auth(alpha),
    reservationId: collision.reservationId,
    content: { objectId: randomBytes(16).toString("hex"),
      plaintextBytes: 4 }, metadata: { objectId: parts.metadata.objectId,
      plaintextBytes: 8 } }), ManagedDraftPairDenied);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_non_day_upload_intents " +
    "WHERE household_id=? AND draft_reservation_id=?")
    .get(alpha.householdId, collision.reservationId).n, 0);

  const expectedWireBytes = 130 + parts.content.plaintextBytes +
    parts.metadata.plaintextBytes;
  const lowQuota = new SqliteDraftPairReservation(db, 4096,
    expectedWireBytes - 1);
  assert.throws(() => lowQuota.openPairedLeases({ ...auth(alpha),
    reservationId: alphaIds.reservationId }), ManagedDraftPairDenied);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_non_day_staging_leases " +
    "WHERE household_id=?").get(alpha.householdId).n, 0);
  const leases = service.openPairedLeases({ ...auth(alpha),
    reservationId: alphaIds.reservationId });
  assert.equal(leases.reservedBytes, expectedWireBytes);
  assert.notEqual(leases.contentAttemptId, leases.metadataAttemptId);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_non_day_staging_leases " +
    "WHERE household_id=?").get(alpha.householdId).n, 2);
  assert.throws(() => service.openPairedLeases({ ...auth(alpha),
    reservationId: alphaIds.reservationId }), ManagedDraftPairDenied);

  const preRotation = reserve(alpha, alphaDraft);
  for (let index = 0; index < 4; index++) reserve(alpha, alphaDraft);
  assert.throws(() => reserve(alpha, alphaDraft), ManagedDraftPairDenied);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_draft_reservations " +
    "WHERE household_id=?").get(alpha.householdId).n, 8);
  rotateDraftScope(db, alpha, alphaDraft, now);
  assert.throws(() => service.bindIntents({ ...auth(alpha),
    reservationId: preRotation.reservationId,
    content: { objectId: randomBytes(16).toString("hex"),
      plaintextBytes: 7 }, metadata: {
      objectId: randomBytes(16).toString("hex"), plaintextBytes: 8 } }),
  ManagedDraftPairDenied);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_non_day_upload_intents " +
    "WHERE household_id=? AND draft_reservation_id=?")
    .get(alpha.householdId, preRotation.reservationId).n, 0);

  const betaIds = reserve(beta, betaDraft);
  const betaParts = { content: { objectId: randomBytes(16).toString("hex"),
    plaintextBytes: 9 }, metadata: { objectId: randomBytes(16).toString("hex"),
    plaintextBytes: 12 } };
  service.bindIntents({ ...auth(beta), reservationId: betaIds.reservationId,
    ...betaParts });
  db.prepare("UPDATE managed_devices SET state='revoked', " +
    "revoked_at=unixepoch('now') WHERE household_id=? AND id=?")
    .run(beta.householdId, beta.deviceId);
  assert.throws(() => service.openPairedLeases({ ...auth(beta),
    reservationId: betaIds.reservationId }), ManagedDraftPairDenied);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_non_day_staging_leases " +
    "WHERE household_id=?").get(beta.householdId).n, 0);
  db.prepare("UPDATE managed_sessions SET revoked_at=unixepoch('now') " +
    "WHERE household_id=? AND id=?")
    .run(alpha.householdId, alpha.session.sessionId);
  assert.throws(() => reserve(alpha, alphaDraft), ManagedDraftPairDenied);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(path)) assert.equal(readFileSync(path).includes(
      Buffer.from(marker)), false);
  }
  console.log("Fictional v10 draft-pair reservation and atomic leases passed;");
  console.log("no route mounted, no migration applied, no real data used.");
} finally { db.close(); }

function seedDraftScope(db, family, now) {
  const scopeId = randomBytes(16).toString("hex");
  const keyId = randomBytes(16).toString("hex");
  const commitment = randomBytes(32);
  const latest = db.prepare("SELECT counter, action_sha256 AS digest " +
    "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
    "ORDER BY counter DESC LIMIT 1")
    .get(family.householdId, family.deviceId);
  let counter = latest.counter;
  let predecessor = latest.digest;
  const action = (kind) => {
    counter += 1;
    const digest = randomBytes(32);
    const payload = randomBytes(32);
    db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)")
      .run(family.householdId, family.deviceId, counter, kind, payload,
        predecessor, digest, randomBytes(64), now);
    predecessor = digest;
    return { counter, payload };
  };
  db.transaction(() => {
    db.prepare("INSERT INTO managed_scopes " +
      "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
      "VALUES (?,?,?,'draft','active',?,?)")
      .run(family.householdId, family.profileId, scopeId, family.deviceId, now);
    const registration = action("key");
    db.prepare("INSERT INTO managed_key_identities " +
      "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
      "key_commitment,signed_payload_sha256,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,1,'draft',?,?,?,?,?)")
      .run(family.householdId, family.profileId, scopeId, keyId, commitment,
        registration.payload, family.deviceId, registration.counter, now);
    const activation = action("key");
    db.prepare("INSERT INTO managed_active_key_events " +
      "(household_id,profile_id,scope_id,sequence,previous_sha256," +
      "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
      "key_commitment,registration_sha256,issuer_device_id,session_id," +
      "issuer_counter,created_at) " +
      "VALUES (?,?,?,1,NULL,NULL,NULL,?,?,1,'draft',?,?,?,?,?,?)")
      .run(family.householdId, family.profileId, scopeId,
        activation.payload, keyId, commitment, registration.payload,
        family.deviceId, family.session.sessionId, activation.counter, now);
    db.prepare("INSERT INTO managed_grant_heads " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "head_sha256,capability_mask,updated_at) VALUES (?,?,?,?,0,NULL,0,?)")
      .run(family.householdId, family.profileId, scopeId, family.deviceId, now);
    const grant = action("grant");
    db.prepare("INSERT INTO managed_grant_events " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,1,NULL,?,3,?,?,?)")
      .run(family.householdId, family.profileId, scopeId, family.deviceId,
        grant.payload, family.deviceId, grant.counter, now);
  }).immediate();
  return { scopeId, keyId };
}

function rotateDraftScope(db, family, scope, now) {
  const newKeyId = randomBytes(16).toString("hex");
  const commitment = randomBytes(32);
  const head = db.prepare("SELECT sequence, head_sha256 AS digest " +
    "FROM managed_active_key_heads WHERE household_id=? " +
    "AND profile_id=? AND scope_id=?")
    .get(family.householdId, family.profileId, scope.scopeId);
  assert.equal(head.sequence, 1);
  const latest = db.prepare("SELECT counter, action_sha256 AS digest " +
    "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
    "ORDER BY counter DESC LIMIT 1")
    .get(family.householdId, family.deviceId);
  let predecessor = latest.digest;
  const action = (counter) => {
    const payload = randomBytes(32);
    const digest = randomBytes(32);
    db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,'key',?,?,?,?,?)")
      .run(family.householdId, family.deviceId, counter, payload,
        predecessor, digest, randomBytes(64), now);
    predecessor = digest;
    return payload;
  };
  db.transaction(() => {
    const registration = action(latest.counter + 1);
    db.prepare("INSERT INTO managed_key_identities " +
      "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
      "key_commitment,signed_payload_sha256,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,2,'draft',?,?,?,?,?)")
      .run(family.householdId, family.profileId, scope.scopeId,
        newKeyId, commitment, registration, family.deviceId,
        latest.counter + 1, now);
    const activation = action(latest.counter + 2);
    db.prepare("INSERT INTO managed_active_key_events " +
      "(household_id,profile_id,scope_id,sequence,previous_sha256," +
      "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
      "key_commitment,registration_sha256,issuer_device_id,session_id," +
      "issuer_counter,created_at) " +
      "VALUES (?,?,?,2,?,?,1,?,?,2,'draft',?,?,?,?,?,?)")
      .run(family.householdId, family.profileId, scope.scopeId,
        head.digest, scope.keyId, activation, newKeyId, commitment,
        registration, family.deviceId, family.session.sessionId,
        latest.counter + 2, now);
  }).immediate();
}

function seedSecondSession(db, family, now) {
  const sessionId = randomBytes(16).toString("hex");
  const challengeId = randomBytes(16).toString("hex");
  const token = issueSessionToken();
  const csrfSecret = randomBytes(32);
  db.transaction(() => {
    db.prepare("INSERT INTO managed_sessions " +
      "(household_id,id,account_id,token_sha256,csrf_secret," +
      "account_auth_version,membership_auth_version,created_at,expires_at) " +
      "VALUES (?,?,?,?,?,1,1,?,?)")
      .run(family.householdId, sessionId, family.accountId,
        Buffer.from(token.sha256, "hex"), csrfSecret, now, now + 3600);
    db.prepare("INSERT INTO managed_session_device_challenges " +
      "(household_id,id,account_id,session_id,device_id,nonce_sha256," +
      "audience_sha256,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(family.householdId, challengeId, family.accountId, sessionId,
        family.deviceId, randomBytes(32), randomBytes(32), now, now + 300);
    db.prepare("UPDATE managed_session_device_challenges SET consumed_at=?, " +
      "proof_signature=? WHERE household_id=? AND id=?")
      .run(now, randomBytes(64), family.householdId, challengeId);
    db.prepare("INSERT INTO managed_session_device_bindings " +
      "(household_id,session_id,account_id,device_id,challenge_id,bound_at) " +
      "VALUES (?,?,?,?,?,?)")
      .run(family.householdId, sessionId, family.accountId, family.deviceId,
        challengeId, now);
  }).immediate();
  return { tokenSha256: token.sha256,
    csrfToken: issueCsrfToken(sessionId, csrfSecret) };
}
