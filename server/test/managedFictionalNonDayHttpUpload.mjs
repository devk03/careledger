import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from
  "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { decodeManagedVaultBlobV2, encodeManagedVaultBlobV2,
  encodePendingDraftPairActionPayloadV1,
  PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1 } from "@adeno/contracts";
import Database from "better-sqlite3";
import express from "express";

import { SESSION_COOKIE_NAME } from "../dist/auth/cookieSession.js";
import { createManagedCiphertextAdmissionRouter } from
  "../dist/managed/ciphertextAdmission.js";
import { readCiphertextChunk } from
  "../dist/managed/ciphertextObjectStore.js";
import { createManagedDraftPairRouter } from
  "../dist/managed/managedDraftPairRouter.js";
import { createManagedPendingDraftPairRouter } from
  "../dist/managed/managedPendingDraftPairRouter.js";
import { SqliteDraftPairReservation } from
  "../dist/managed/sqliteDraftPairReservation.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { SqliteManagedSessions } from
  "../dist/managed/sqliteManagedSessions.js";
import { createNonDayDraftUploadComposition } from
  "../dist/managed/nonDayDraftUploadComposition.js";
import { ManagedPendingDraftPairDenied, submitPendingDraftPair } from
  "../dist/managed/sqlitePendingDraftPairWriter.js";
import { SqliteNonDayDraftUploadLedger } from
  "../dist/managed/sqliteNonDayDraftUploadLedger.js";
import { createManagedUploadReceiptRouter } from
  "../dist/managed/uploadReceipt.js";
import { encryptManagedVaultBlobV2, decryptManagedVaultBlobV2 } from
  "../../web/src/crypto/managedVaultV2.ts";
import { prepareLocalEncryptedDraft } from
  "../../web/src/managed/intakeDraft.ts";
import { signPendingDraftPair } from
  "../../web/src/crypto/signedPendingDraftPair.ts";
import { generateDeviceEncryptionKeys } from
  "../../web/src/crypto/dayKeyEnvelope.ts";
import { createScopeKeyEnvelopesV2 } from
  "../../web/src/crypto/scopeKeyEnvelopeV2.ts";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

// Explicitly approved, empty, fictional v10 source only. This test copies it;
// it never migrates or writes the source and never reads real case records.
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

const root = await mkdtemp(join(tmpdir(), "adeno-fictional-non-day-http-"));
const dbPath = join(root, "managed.sqlite3");
const objectRoot = await mkdtemp(join(root, "objects-"));
await copyFile(sourcePath, dbPath);
await chmod(dbPath, 0o600);
const db = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
let server;
try {
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma("synchronous = EXTRA");
  assertManagedSchema(db);
  const now = Math.floor(Date.now() / 1000);
  const signingKeys = generateKeyPairSync("ed25519");
  const enrolledSigningPublicKey = signingKeys.publicKey.export({
    format: "der", type: "spki" }).subarray(-32);
  const [alpha, beta] = db.transaction(() => [
    seedFictionalManagedFamily(db, "1", "2", now,
      { enrolledSigningPublicKey }),
    seedFictionalManagedFamily(db, "6", "7", now,
      { intentByte: "c", blobByte: "d" }),
  ]).immediate();
  const alphaDraft = seedDraftScope(db, alpha, now);
  const betaDraft = seedDraftScope(db, beta, now);
  const reservation = new SqliteDraftPairReservation(db, 1024 * 1024,
    2 * 1024 * 1024);
  const composition = createNonDayDraftUploadComposition({ connection: db,
    objectRoot, maxStoredBytesPerFamily: 1024 * 1024,
    maxGlobalStoredBytes: 2 * 1024 * 1024 });
  const sessions = new SqliteManagedSessions(db);
  const app = express();
  let limitMode = "allow";
  server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  app.use("/api/managed/draft-pairs", createManagedDraftPairRouter({
    expectedOrigin: base, service: reservation,
    rateLimit: () => {
      if (limitMode === "error") throw new Error("fictional limiter unavailable");
      return limitMode === "allow";
    },
  }));
  app.use("/api/managed/pending-pairs", createManagedPendingDraftPairRouter({
    expectedOrigin: base,
    submit: (submission) => submitPendingDraftPair(db, submission),
    rateLimit: () => {
      if (limitMode === "error") throw new Error("fictional limiter unavailable");
      return limitMode === "allow";
    },
  }));
  app.use(createManagedCiphertextAdmissionRouter({ sessions,
    expectedOrigin: base, store: composition.store }));
  app.use(createManagedUploadReceiptRouter({ expectedOrigin: base,
    reader: composition.receipts }));
  const auth = (family) => ({ tokenSha256: family.tokenSha256,
    csrfToken: family.csrfToken });
  const headers = (family, contentType = true) => ({
    cookie: `${SESSION_COOKIE_NAME}=${family.sessionToken}`,
    origin: base, "sec-fetch-site": "same-origin",
    "x-csrf-token": family.csrfToken,
    ...(contentType ? { "content-type": "application/vnd.adeno.vault.v2" } : {}),
  });
  const url = (ids, role) => `${base}/api/v3/vault/intents/` +
    `${ids[`${role}IntentId`]}/blobs/${ids[`${role}BlobId`]}`;
  const receipt = (ids, role, family) => fetch(`${url(ids, role)}/receipt`, {
    method: "POST", headers: headers(family, false),
  });
  const draftPost = (action, family, body, overrides = {}) =>
    fetch(`${base}/api/managed/draft-pairs/${action}`, {
      method: "POST", headers: { ...headers(family),
        "content-type": "application/json", ...overrides },
      body: JSON.stringify(body),
    });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]);
  const marker = "FICTIONAL_DRAFT_RECORD_NOT_A_REAL_PERSON";
  const contentPlain = new TextEncoder().encode(marker);
  async function pair(family, scope, content = contentPlain) {
    const beforePair = {
      reservations: db.prepare("SELECT count(*) AS n FROM " +
        "managed_draft_reservations").get().n,
      intents: db.prepare("SELECT count(*) AS n FROM " +
        "managed_non_day_upload_intents").get().n,
      leases: db.prepare("SELECT count(*) AS n FROM " +
        "managed_non_day_staging_leases").get().n,
    };
    const reserveBody = { reservationId: randomBytes(16).toString("hex"),
      profileId: family.profileId, scopeId: scope.scopeId,
      keyId: scope.keyId, epoch: 1 };
    const reserved = await draftPost("reserve", family, reserveBody);
    const ids = await reserved.json();
    assert.equal(reserved.status, 201, JSON.stringify(ids));
    const reserveRetry = await draftPost("reserve", family, reserveBody);
    assert.equal(reserveRetry.status, 201);
    assert.deepEqual(await reserveRetry.json(), ids);
    assert.equal(Object.keys(ids).sort().join(), ["reservationId",
      "contentIntentId", "metadataIntentId", "contentBlobId",
      "metadataBlobId", "expiresAt"].sort().join());
    let objectIds = { content: randomBytes(16).toString("hex"),
      metadata: randomBytes(16).toString("hex") };
    const draftScope = (role) => ({ householdId: family.householdId,
      careProfileId: family.profileId, opaqueScopeId: scope.scopeId,
      objectId: objectIds[role], keyEpoch: 1,
      purpose: "review-draft", revision: 1 });
    let contentBlob;
    let metadataBlob;
    let wires;
    if (scope.browserDraftKey) {
      const prepared = await prepareLocalEncryptedDraft({
        identity: { householdId: family.householdId,
          careProfileId: family.profileId, opaqueDraftId: scope.scopeId,
          keyEpoch: 1 }, key: scope.browserDraftKey,
        reservedBlobIds: { content: ids.contentBlobId,
          metadata: ids.metadataBlobId },
        clientSelectedAt: "2026-09-01T12:00:00.000Z",
        candidateCareDays: ["2026-09-01"],
        kind: "family_note", body: new TextDecoder().decode(content),
        authorLabel: "Fictional caregiver" });
      objectIds = { content: prepared.contentObjectId,
        metadata: prepared.metadataObjectId };
      wires = { content: Buffer.from(prepared.contentWire),
        metadata: Buffer.from(prepared.metadataWire) };
      contentBlob = decodeManagedVaultBlobV2(wires.content);
      metadataBlob = decodeManagedVaultBlobV2(wires.metadata);
    } else {
      const metadataBytes = new TextEncoder().encode(JSON.stringify({
        format: "fictional-only", contentBlobId: ids.contentBlobId }));
      contentBlob = await encryptManagedVaultBlobV2(key, content,
        draftScope("content"), Buffer.from(ids.contentBlobId, "hex"));
      metadataBlob = await encryptManagedVaultBlobV2(key, metadataBytes,
        draftScope("metadata"), Buffer.from(ids.metadataBlobId, "hex"));
      wires = { content: Buffer.from(encodeManagedVaultBlobV2(contentBlob)),
        metadata: Buffer.from(encodeManagedVaultBlobV2(metadataBlob)) };
    }
    const bindBody = {
      reservationId: ids.reservationId,
      content: { objectId: objectIds.content,
        plaintextBytes: contentBlob.plaintextSize },
      metadata: { objectId: objectIds.metadata,
        plaintextBytes: metadataBlob.plaintextSize } };
    const bound = await draftPost("bind-intents", family, bindBody);
    const boundIds = await bound.json();
    assert.equal(bound.status, 201, JSON.stringify(boundIds));
    const bindRetry = await draftPost("bind-intents", family, bindBody);
    assert.equal(bindRetry.status, 201);
    assert.deepEqual(await bindRetry.json(), boundIds);
    assert.equal((await draftPost("bind-intents", family, {
      ...bindBody, metadata: { ...bindBody.metadata,
        objectId: randomBytes(16).toString("hex") } })).status, 404);
    const leased = await draftPost("open-leases", family,
      { reservationId: ids.reservationId });
    const leases = await leased.json();
    assert.equal(leased.status, 201, JSON.stringify(leases));
    const leaseRetry = await draftPost("open-leases", family,
      { reservationId: ids.reservationId });
    assert.equal(leaseRetry.status, 201);
    assert.deepEqual(await leaseRetry.json(), leases);
    assert.match(leases.contentAttemptId, /^[0-9a-f]{32}$/u);
    assert.match(leases.metadataAttemptId, /^[0-9a-f]{32}$/u);
    assert.equal(db.prepare("SELECT count(*) AS n FROM " +
      "managed_draft_reservations").get().n, beforePair.reservations + 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM " +
      "managed_non_day_upload_intents").get().n, beforePair.intents + 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM " +
      "managed_non_day_staging_leases").get().n, beforePair.leases + 2);
    return { ids, wires, blobs: { content: contentBlob,
      metadata: metadataBlob }, draftScope, leases, reserveBody, bindBody,
    boundIds };
  }

  const alphaPair = await pair(alpha, alphaDraft);
  const counts = () => ({ reservations: db.prepare("SELECT count(*) AS n " +
    "FROM managed_draft_reservations").get().n,
  intents: db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_upload_intents").get().n,
  leases: db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_staging_leases").get().n });
  const beforeDeniedRequests = counts();
  const deniedReserve = { reservationId: randomBytes(16).toString("hex"),
    profileId: alpha.profileId, scopeId: alphaDraft.scopeId,
    keyId: alphaDraft.keyId, epoch: 1 };
  assert.equal((await draftPost("reserve", alpha, deniedReserve,
  { "x-csrf-token": "wrong" })).status, 404);
  assert.equal((await draftPost("reserve", alpha, deniedReserve,
  { origin: "https://attacker.example" })).status, 403);
  assert.equal((await draftPost("reserve", alpha, {
    ...deniedReserve, patientName: "never allowed" })).status,
  400);
  assert.equal((await draftPost("reserve", alpha, deniedReserve,
  { "content-encoding": "gzip" })).status, 400);
  assert.equal((await draftPost("reserve", alpha, {
    ...deniedReserve, padding: "x".repeat(3_000) })).status, 413);
  assert.equal((await draftPost("open-leases", beta,
    { reservationId: alphaPair.ids.reservationId })).status, 404);
  const stableLeases = await draftPost("open-leases", alpha,
    { reservationId: alphaPair.ids.reservationId });
  assert.equal(stableLeases.status, 201);
  assert.deepEqual(await stableLeases.json(), alphaPair.leases);
  assert.equal((await fetch(`${base}/api/managed/draft-pairs/reserve`, {
    method: "GET", headers: headers(alpha, false) })).status, 405);
  const options = await fetch(`${base}/api/managed/draft-pairs/reserve`, {
    method: "OPTIONS", headers: headers(alpha, false) });
  assert.equal(options.status, 405);
  assert.equal(options.headers.get("access-control-allow-origin"), null);
  limitMode = "deny";
  assert.equal((await draftPost("reserve", alpha,
    alphaPair.reserveBody)).status, 429);
  assert.equal((await draftPost("reserve", alpha, deniedReserve)).status, 429);
  limitMode = "error";
  assert.equal((await draftPost("reserve", alpha, deniedReserve)).status, 503);
  limitMode = "allow";
  assert.deepEqual(counts(), beforeDeniedRequests);
  const before = db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
    "FROM managed_wire_occupancy").get().bytes;
  assert.equal(before, alphaPair.wires.content.byteLength +
    alphaPair.wires.metadata.byteLength);
  assert.equal((await receipt(alphaPair.ids, "content", alpha)).status, 202);
  assert.equal((await receipt(alphaPair.ids, "metadata", alpha)).status, 202);
  assert.equal((await fetch(url(alphaPair.ids, "content"), {
    method: "POST", headers: headers(beta),
    body: alphaPair.wires.content })).status, 404);
  assert.equal((await receipt(alphaPair.ids, "content", beta)).status, 404);
  assert.equal((await fetch(url(alphaPair.ids, "content"), {
    method: "POST", headers: { ...headers(alpha), "x-csrf-token": "wrong" },
    body: alphaPair.wires.content })).status, 403);
  assert.equal((await fetch(url(alphaPair.ids, "content"), {
    method: "POST", headers: { ...headers(alpha),
      origin: "https://attacker.example" },
    body: alphaPair.wires.content })).status, 403);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_committed_blobs").get().n, 0);

  for (const role of ["content", "metadata"]) {
    const uploaded = await fetch(url(alphaPair.ids, role), {
      method: "POST", headers: headers(alpha), body: alphaPair.wires[role],
    });
    const uploadBody = await uploaded.json();
    assert.equal(uploaded.status, 201, JSON.stringify(uploadBody));
    const response = await receipt(alphaPair.ids, role, alpha);
    const receiptBody = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receiptBody));
    assert.deepEqual(receiptBody, { status: "committed",
      wireSha256: createHash("sha256").update(alphaPair.wires[role])
        .digest("hex"), wireBytes: alphaPair.wires[role].byteLength });
    if (role === "content") {
      const beforeReadback = counts();
      const reserveReadback = await draftPost("reserve", alpha,
        alphaPair.reserveBody);
      assert.equal(reserveReadback.status, 201);
      assert.deepEqual(await reserveReadback.json(), alphaPair.ids);
      const bindReadback = await draftPost("bind-intents", alpha,
        alphaPair.bindBody);
      assert.equal(bindReadback.status, 201);
      assert.deepEqual(await bindReadback.json(), alphaPair.boundIds);
      assert.equal((await draftPost("open-leases", alpha,
        { reservationId: alphaPair.ids.reservationId })).status, 404);
      assert.deepEqual(counts(), beforeReadback);
    }
    assert.equal(db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
      "FROM managed_wire_occupancy").get().bytes, before);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_committed_blobs WHERE household_id=?")
    .get(alpha.householdId).n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_staging_leases WHERE household_id=? " +
    "AND committed_at IS NULL").get(alpha.householdId).n, 0);

  const keyRow = db.prepare("SELECT key_commitment AS commitment " +
    "FROM managed_key_identities WHERE household_id=? AND key_id=? " +
    "AND epoch=1").get(alpha.householdId, alphaDraft.keyId);
  const activeHead = db.prepare("SELECT head_sha256 AS digest FROM " +
    "managed_current_scope_keys WHERE household_id=? AND profile_id=? " +
    "AND scope_id=?").get(alpha.householdId, alpha.profileId,
      alphaDraft.scopeId);
  const grantHead = db.prepare("SELECT head_sha256 AS digest FROM " +
    "managed_grant_heads WHERE household_id=? AND profile_id=? " +
    "AND scope_id=? AND subject_device_id=?")
    .get(alpha.householdId, alpha.profileId, alphaDraft.scopeId,
      alpha.deviceId);
  const predecessor = db.prepare("SELECT counter, action_sha256 AS digest " +
    "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
    "ORDER BY counter DESC LIMIT 1")
    .get(alpha.householdId, alpha.deviceId);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const context = { householdId: alpha.householdId,
    careProfileId: alpha.profileId, opaqueDraftScopeId: alphaDraft.scopeId,
    keyId: alphaDraft.keyId, reservationId: alphaPair.ids.reservationId,
    contentIntentId: alphaPair.ids.contentIntentId,
    metadataIntentId: alphaPair.ids.metadataIntentId,
    contentBlobId: alphaPair.ids.contentBlobId,
    metadataBlobId: alphaPair.ids.metadataBlobId,
    contentObjectId: alphaPair.draftScope("content").objectId,
    metadataObjectId: alphaPair.draftScope("metadata").objectId,
    authorDeviceId: alpha.deviceId, sessionId: alpha.session.sessionId,
    keyEpoch: 1, authorCounter: BigInt(predecessor.counter + 1),
    pairedAt: BigInt(db.prepare("SELECT unixepoch('now') AS now").get().now),
    contentWireBytes: alphaPair.wires.content.byteLength,
    metadataWireBytes: alphaPair.wires.metadata.byteLength,
    keyCommitmentSha256: keyRow.commitment.toString("hex"),
    activeKeyHeadSha256: activeHead.digest.toString("hex"),
    grantHeadSha256: grantHead.digest.toString("hex"),
    contentWireSha256: sha256(alphaPair.wires.content),
    metadataWireSha256: sha256(alphaPair.wires.metadata),
    previousActionSha256: predecessor.digest.toString("hex"),
    issuerSigningKeySha256: sha256(enrolledSigningPublicKey) };
  const payload = encodePendingDraftPairActionPayloadV1(context);
  const signature = sign(null, payload, signingKeys.privateKey);
  const action = { householdId: context.householdId,
    deviceId: context.authorDeviceId, counter: context.authorCounter,
    actionKind: "review", payloadSha256: sha256(payload),
    previousActionSha256: context.previousActionSha256,
    actionSha256: sha256(Buffer.concat([
      Buffer.from(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
      Buffer.from(payload), signature])), signature,
    createdAt: context.pairedAt };
  const submit = (changes = {}) => submitPendingDraftPair(db, {
    tokenSha256: alpha.tokenSha256, csrfToken: alpha.csrfToken,
    context, action, ...changes });
  const beforePairAction = db.prepare("SELECT count(*) AS n FROM " +
    "managed_signed_actions WHERE household_id=?")
    .get(alpha.householdId).n;
  for (const change of [
    { csrfToken: "wrong" },
    { tokenSha256: beta.tokenSha256 },
    { context: { ...context, metadataWireSha256: "00".repeat(32) } },
    { action: { ...action, signature: Buffer.alloc(64) } },
  ]) assert.throws(() => submit(change), ManagedPendingDraftPairDenied);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_signed_actions " +
    "WHERE household_id=?").get(alpha.householdId).n, beforePairAction);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_pending_draft_pairs").get().n, 0);
  const signedBody = { context: { ...context,
    authorCounter: context.authorCounter.toString(),
    pairedAt: context.pairedAt.toString() },
    signature: signature.toString("base64") };
  const pairPost = (family, body, overrides = {}) =>
    fetch(`${base}/api/managed/pending-pairs/submit`, {
      method: "POST", headers: { ...headers(family),
        "content-type": "application/json", ...overrides },
      body: JSON.stringify(body),
    });
  assert.equal((await pairPost(alpha, signedBody,
    { "x-csrf-token": "wrong" })).status, 404);
  assert.equal((await pairPost(alpha, signedBody,
    { origin: "https://unrelated.invalid" })).status, 403);
  assert.equal((await pairPost(beta, signedBody)).status, 404);
  assert.equal((await pairPost(alpha, { ...signedBody,
    context: { ...signedBody.context,
      metadataWireSha256: "00".repeat(32) } })).status, 404);
  assert.equal((await pairPost(alpha, { ...signedBody,
    signature: Buffer.alloc(64).toString("base64") })).status, 404);
  assert.equal((await pairPost(alpha, { ...signedBody,
    unexpected: true })).status, 400);
  const lockHolder = new Database(dbPath, { fileMustExist: true });
  lockHolder.exec("BEGIN IMMEDIATE");
  db.pragma("busy_timeout = 50");
  try {
    const busy = await pairPost(alpha, signedBody);
    assert.equal(busy.status, 503);
    assert.deepEqual(await busy.json(), { error: "RETRY_SAME_SUBMISSION" });
  } finally {
    lockHolder.exec("ROLLBACK");
    lockHolder.close();
    db.pragma("busy_timeout = 5000");
  }
  const posted = await pairPost(alpha, signedBody);
  assert.equal(posted.status, 201);
  const pending = await posted.json();
  assert.deepEqual(pending, { status: "pending",
    reservationId: context.reservationId, pairSha256: action.payloadSha256 });
  const postedRetry = await pairPost(alpha, signedBody);
  assert.equal(postedRetry.status, 201);
  assert.deepEqual(await postedRetry.json(), pending);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_signed_actions " +
    "WHERE household_id=?").get(alpha.householdId).n,
  beforePairAction + 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_pending_draft_pairs WHERE household_id=?")
    .get(alpha.householdId).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_pending_draft_blob_uses WHERE household_id=?")
    .get(alpha.householdId).n, 2);
  assert.throws(() => submit({ action: { ...action,
    signature: Buffer.alloc(64) } }), ManagedPendingDraftPairDenied);
  limitMode = "deny";
  assert.equal((await pairPost(alpha, signedBody)).status, 429);
  limitMode = "allow";

  for (const role of ["content", "metadata"]) {
    const row = db.prepare("SELECT nonce AS iv, storage_object_id AS objectId, " +
      "ciphertext_sha256 AS digest, ciphertext_bytes AS bytes " +
      "FROM managed_non_day_blob_chunks WHERE household_id=? AND intent_id=?")
      .get(alpha.householdId, alphaPair.ids[`${role}IntentId`]);
    assert.ok(row);
    const disk = await readCiphertextChunk(objectRoot, alpha.householdId,
      row.objectId, row.digest.toString("hex"), row.bytes);
    assert.equal(disk.includes(contentPlain), false);
    const stored = { ...alphaPair.blobs[role],
      chunks: [{ iv: Uint8Array.from(row.iv), ciphertext: disk.buffer.slice(
        disk.byteOffset, disk.byteOffset + disk.byteLength) }] };
    assert.deepEqual(await decryptManagedVaultBlobV2(key, stored,
      alphaPair.draftScope(role)), role === "content" ? contentPlain :
      new TextEncoder().encode(JSON.stringify({ format: "fictional-only",
        contentBlobId: alphaPair.ids.contentBlobId })));
  }
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`,
    `${dbPath}-journal`]) {
    if (existsSync(candidate))
      assert.equal(readFileSync(candidate).includes(Buffer.from(marker)), false);
  }
  // A duplicate nonce across two drafts under one key must roll back both
  // intermediate rows, even after the new ciphertext object was staged.
  const collisionPair = await pair(alpha, alphaDraft);
  const earlierNonce = db.prepare("SELECT nonce FROM " +
    "managed_non_day_blob_chunks WHERE household_id=? AND intent_id=?")
    .get(alpha.householdId, alphaPair.ids.contentIntentId).nonce;
  const collisionWire = Buffer.from(collisionPair.wires.content);
  earlierNonce.copy(collisionWire, 33);
  assert.equal((await fetch(url(collisionPair.ids, "content"), {
    method: "POST", headers: headers(alpha), body: collisionWire,
  })).status, 409);
  assert.equal((await receipt(collisionPair.ids, "content", alpha)).status,
    202);
  for (const table of ["managed_non_day_nonce_reservations",
    "managed_non_day_blob_chunks", "managed_non_day_committed_blobs"]) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} ` +
      "WHERE household_id=? AND intent_id=?")
      .get(alpha.householdId, collisionPair.ids.contentIntentId).n, 0);
  }
  const reopened = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
  try {
    reopened.pragma("foreign_keys = ON");
    reopened.pragma("trusted_schema = OFF");
    reopened.pragma("synchronous = EXTRA");
    const reader = new SqliteNonDayDraftUploadLedger(reopened,
      1024 * 1024, 2 * 1024 * 1024);
    assert.equal((await reader.readReceipt({ ...auth(alpha),
      intentId: alphaPair.ids.contentIntentId,
      blobId: alphaPair.ids.contentBlobId })).status, "committed");
  } finally { reopened.close(); }

  const badPair = await pair(beta, betaDraft);
  const malformed = await fetch(url(badPair.ids, "content"), {
    method: "POST", headers: headers(beta), body: Buffer.from("not a v2 wire"),
  });
  assert.equal(malformed.status, 422);
  assert.equal((await receipt(badPair.ids, "content", beta)).status, 202);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_nonce_reservations WHERE household_id=?")
    .get(beta.householdId).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_blob_chunks WHERE household_id=?")
    .get(beta.householdId).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_non_day_committed_blobs WHERE household_id=?")
    .get(beta.householdId).n, 0);
  db.prepare("UPDATE managed_devices SET state='revoked', " +
    "revoked_at=unixepoch('now') WHERE household_id=? AND id=?")
    .run(beta.householdId, beta.deviceId);
  assert.equal((await fetch(url(badPair.ids, "metadata"), {
    method: "POST", headers: headers(beta), body: badPair.wires.metadata,
  })).status, 401);
  assert.equal((await receipt(badPair.ids, "metadata", beta)).status, 401);
  const recipientEncryptionKeys = await generateDeviceEncryptionKeys();
  const browserScopeId = randomBytes(16).toString("hex");
  const browserKeyId = randomBytes(16).toString("hex");
  const browserKey = await createScopeKeyEnvelopesV2({
    householdId: alpha.householdId, careProfileId: alpha.profileId,
    opaqueScopeId: browserScopeId, keyId: browserKeyId, keyEpoch: 1,
    purpose: "draft" }, [{ deviceId: alpha.deviceId,
    publicKey: recipientEncryptionKeys.publicKey }]);
  const browserScope = seedDraftScope(db, alpha, now, {
    scopeId: browserScopeId, keyId: browserKeyId,
    commitment: Buffer.from(browserKey.keyCommitmentSha256, "hex") });
  browserScope.browserDraftKey = browserKey.key;
  const browserPair = await pair(alpha, browserScope);
  for (const role of ["content", "metadata"]) {
    const uploaded = await fetch(url(browserPair.ids, role), {
      method: "POST", headers: headers(alpha), body: browserPair.wires[role],
    });
    assert.equal(uploaded.status, 201);
  }
  const signingPrivate = await crypto.subtle.importKey("pkcs8",
    signingKeys.privateKey.export({ format: "der", type: "pkcs8" }),
    { name: "Ed25519" }, false, ["sign"]);
  const signingPublic = await crypto.subtle.importKey("raw",
    enrolledSigningPublicKey, { name: "Ed25519" }, true, ["verify"]);
  const browserPredecessor = db.prepare("SELECT counter, " +
    "action_sha256 AS digest FROM managed_signed_actions " +
    "WHERE household_id=? AND device_id=? ORDER BY counter DESC LIMIT 1")
    .get(alpha.householdId, alpha.deviceId);
  const browserHead = db.prepare("SELECT head_sha256 AS digest FROM " +
    "managed_current_scope_keys WHERE household_id=? AND profile_id=? " +
    "AND scope_id=?").get(alpha.householdId, alpha.profileId,
      browserScope.scopeId);
  const browserGrant = db.prepare("SELECT head_sha256 AS digest FROM " +
    "managed_grant_heads WHERE household_id=? AND profile_id=? " +
    "AND scope_id=? AND subject_device_id=?")
    .get(alpha.householdId, alpha.profileId, browserScope.scopeId,
      alpha.deviceId);
  const signedBrowserPair = await signPendingDraftPair({
    claims: { householdId: alpha.householdId,
      careProfileId: alpha.profileId,
      opaqueDraftScopeId: browserScope.scopeId,
      keyId: browserScope.keyId,
      reservationId: browserPair.ids.reservationId,
      contentIntentId: browserPair.ids.contentIntentId,
      metadataIntentId: browserPair.ids.metadataIntentId,
      contentBlobId: browserPair.ids.contentBlobId,
      metadataBlobId: browserPair.ids.metadataBlobId,
      contentObjectId: browserPair.draftScope("content").objectId,
      metadataObjectId: browserPair.draftScope("metadata").objectId,
      authorDeviceId: alpha.deviceId, sessionId: alpha.session.sessionId,
      keyEpoch: 1, authorCounter: BigInt(browserPredecessor.counter + 1),
      keyCommitmentSha256: browserKey.keyCommitmentSha256,
      activeKeyHeadSha256: browserHead.digest.toString("hex"),
      grantHeadSha256: browserGrant.digest.toString("hex"),
      previousActionSha256: browserPredecessor.digest.toString("hex") },
    contentWire: browserPair.wires.content,
    metadataWire: browserPair.wires.metadata,
    draftKeyEnvelope: browserKey.envelopes[0],
    recipientEncryptionKeys,
    signingKeys: { privateKey: signingPrivate, publicKey: signingPublic },
    csrfToken: alpha.csrfToken,
    fetcher: (path, options) => fetch(new URL(String(path), base), {
      ...options, headers: { ...headers(alpha, false),
        ...options.headers } }),
  });
  const browserPosted = await pairPost(alpha, { context: {
    ...signedBrowserPair.context,
    authorCounter: signedBrowserPair.context.authorCounter.toString(),
    pairedAt: signedBrowserPair.context.pairedAt.toString() },
    signature: Buffer.from(signedBrowserPair.signature).toString("base64") });
  assert.equal(browserPosted.status, 201);
  assert.deepEqual(await browserPosted.json(), { status: "pending",
    reservationId: browserPair.ids.reservationId,
    pairSha256: signedBrowserPair.payloadSha256 });
  for (const role of ["content", "metadata"]) {
    const row = db.prepare("SELECT storage_object_id AS objectId, " +
      "ciphertext_sha256 AS digest, ciphertext_bytes AS bytes FROM " +
      "managed_non_day_blob_chunks WHERE household_id=? AND intent_id=?")
      .get(alpha.householdId, browserPair.ids[`${role}IntentId`]);
    const disk = await readCiphertextChunk(objectRoot, alpha.householdId,
      row.objectId, row.digest.toString("hex"), row.bytes);
    assert.equal(disk.includes(contentPlain), false);
  }
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`,
    `${dbPath}-journal`]) {
    if (existsSync(candidate))
      assert.equal(readFileSync(candidate).includes(Buffer.from(marker)), false);
  }
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  process.stdout.write("PASS: fictional non-day draft upload/receipt, browser signer code and signed pending-pair submission through unmounted Express routes; private ciphertext, exact retry, cross-family/revocation denial; no migration or real records.\n");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
}

function seedDraftScope(db, family, now, options = {}) {
  const scopeId = options.scopeId ?? randomBytes(16).toString("hex");
  const keyId = options.keyId ?? randomBytes(16).toString("hex");
  const commitment = options.commitment ?? randomBytes(32);
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
