import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { encodeManagedVaultBlobV2 } from "@adeno/contracts";
import Database from "better-sqlite3";
import express from "express";

import { SESSION_COOKIE_NAME } from "../dist/auth/cookieSession.js";
import { createManagedCiphertextAdmissionRouter } from
  "../dist/managed/ciphertextAdmission.js";
import { readCiphertextChunk } from
  "../dist/managed/ciphertextObjectStore.js";
import { createManagedUploadComposition } from
  "../dist/managed/managedUploadComposition.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { inspectExpiredManagedLeases } from
  "../dist/managed/expiredLeaseReport.js";
import { SqliteManagedSessions } from
  "../dist/managed/sqliteManagedSessions.js";
import { createManagedUploadReceiptRouter } from
  "../dist/managed/uploadReceipt.js";
import { encryptManagedVaultBlobV2, decryptManagedVaultBlobV2 } from
  "../../web/src/crypto/managedVaultV2.ts";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

// Run with Node --experimental-strip-types. This uses only a private copy of
// the exact approved empty v10 fictional DB and invented plaintext marker.
const APPROVED_DIRECTORY = "adeno-fictional-managed-fJAg4s";
const APPROVED_EMPTY_SHA256 =
  "2c3ee411bc91d720ffe1586badf071abe9b2ce9e1225b35a4de49a64c5ceb027";
const sourcePath = process.argv[2];
const sourceParent = typeof sourcePath === "string" ?
  realpathSync(dirname(sourcePath)) : "";
assert.equal(process.env.ADENO_APPROVED_FICTIONAL_MIGRATION, "1");
assert.equal(process.env.NODE_ENV === "production", false);
assert.equal(Object.keys(process.env).some((name) => name.startsWith("RAILWAY_")), false);
assert.equal(basename(sourcePath), "managed.sqlite3");
assert.equal(basename(sourceParent), APPROVED_DIRECTORY);
assert.equal(dirname(sourceParent), realpathSync(tmpdir()));
assert.equal(realpathSync(sourcePath), join(sourceParent, "managed.sqlite3"));
assert.equal(statSync(sourcePath).mode & 0o077, 0);
assert.equal(existsSync(`${sourcePath}-wal`), false);
assert.equal(existsSync(`${sourcePath}-shm`), false);
assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
  APPROVED_EMPTY_SHA256);

const testRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-http-vault-"));
const dbPath = join(testRoot, "managed.sqlite3");
const objectRoot = await mkdtemp(join(testRoot, "objects-"));
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
  const marker = "FICTIONAL_ENCRYPTED_RECORD_NOT_A_PERSON";
  const [alpha, beta] = db.transaction(() => [
    seedFictionalManagedFamily(db, "1", "2", now,
      { plaintextBytes: Buffer.byteLength(marker) }),
    seedFictionalManagedFamily(db, "6", "7", now,
      { intentByte: "c", blobByte: "d" }),
  ]).immediate();
  const sessions = new SqliteManagedSessions(db);
  const composition = createManagedUploadComposition({ connection: db,
    objectRoot, maxStoredBytesPerFamily: 1024 * 1024,
    maxGlobalStoredBytes: 2 * 1024 * 1024 });
  const app = express();
  server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  app.use(createManagedCiphertextAdmissionRouter({ sessions,
    expectedOrigin: base, store: composition.store }));
  app.use(createManagedUploadReceiptRouter({ expectedOrigin: base,
    reader: composition.receipts }));
  const path = (fixture, intentId = fixture.intentId,
    blobId = fixture.blobId) =>
    `/api/v3/vault/intents/${intentId}/blobs/${blobId}`;
  const headers = (fixture, contentType = true) => ({
    cookie: `${SESSION_COOKIE_NAME}=${fixture.sessionToken}`,
    origin: base, "sec-fetch-site": "same-origin",
    "x-csrf-token": fixture.csrfToken,
    ...(contentType ? { "content-type": "application/vnd.adeno.vault.v2" } : {}),
  });
  const plaintext = new TextEncoder().encode(marker);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]);
  const scope = { householdId: alpha.householdId,
    careProfileId: alpha.profileId, opaqueScopeId: alpha.scopeId,
    objectId: randomBytes(16).toString("hex"), keyEpoch: 1,
    purpose: "day-snapshot", revision: 1 };
  const encrypted = await encryptManagedVaultBlobV2(key, plaintext, scope,
    Buffer.from(alpha.blobId, "hex"));
  const wire = Buffer.from(encodeManagedVaultBlobV2(encrypted));
  assert.equal(wire.includes(plaintext), false);
  const uploadUrl = `${base}${path(alpha)}`;

  const crossFamily = await fetch(uploadUrl, { method: "POST",
    headers: headers(beta), body: wire });
  assert.equal(crossFamily.status, 404, await crossFamily.text());
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=?").get(beta.householdId).n, 0);
  const missingCsrf = await fetch(uploadUrl, { method: "POST",
    headers: { ...headers(alpha), "x-csrf-token": "wrong" }, body: wire });
  assert.equal(missingCsrf.status, 403);
  const wrongOrigin = await fetch(uploadUrl, { method: "POST",
    headers: { ...headers(alpha), origin: "https://attacker.example" }, body: wire });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=?").get(alpha.householdId).n, 0);
  const uploaded = await fetch(uploadUrl, { method: "POST",
    headers: headers(alpha), body: wire });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json(), { status: "stored" });
  const receiptUrl = `${uploadUrl}/receipt`;
  const receipt = await fetch(receiptUrl, { method: "POST",
    headers: headers(alpha, false) });
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { status: "committed",
    wireSha256: createHash("sha256").update(wire).digest("hex"),
    wireBytes: wire.byteLength });
  assert.equal((await fetch(receiptUrl, { method: "POST",
    headers: headers(beta, false) })).status, 404);
  const chunk = db.prepare("SELECT nonce AS iv, storage_object_id AS objectId, " +
    "ciphertext_sha256 AS digest, ciphertext_bytes AS bytes " +
    "FROM managed_blob_chunks WHERE household_id=? AND intent_id=?")
    .get(alpha.householdId, alpha.intentId);
  assert.ok(chunk);
  const disk = await readCiphertextChunk(objectRoot, alpha.householdId,
    chunk.objectId, chunk.digest.toString("hex"), chunk.bytes);
  assert.equal(disk.includes(plaintext), false);
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`,
    `${dbPath}-journal`]) {
    if (existsSync(candidate))
      assert.equal(readFileSync(candidate).includes(Buffer.from(marker)), false);
  }
  const storedBlob = { format: encrypted.format, blobId: encrypted.blobId,
    plaintextSize: encrypted.plaintextSize, chunkSize: encrypted.chunkSize,
    chunks: [{ iv: Uint8Array.from(chunk.iv),
      ciphertext: disk.buffer.slice(disk.byteOffset,
        disk.byteOffset + disk.byteLength) }] };
  assert.deepEqual(await decryptManagedVaultBlobV2(key, storedBlob, scope),
    plaintext);

  const invalidIntentId = randomBytes(16).toString("hex");
  const invalidBlobId = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,0,1,?,?)")
    .run(alpha.householdId, invalidIntentId, alpha.profileId,
      alpha.scopeId, alpha.keyId, invalidBlobId, alpha.deviceId,
      alpha.session.sessionId, now, now + 600);
  const malformed = await fetch(`${base}${path(alpha,
    invalidIntentId, invalidBlobId)}`, { method: "POST",
    headers: headers(alpha), body: Buffer.from("fictional malformed wire") });
  assert.equal(malformed.status, 422);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_committed_blobs " +
    "WHERE household_id=? AND intent_id=?")
    .get(alpha.householdId, invalidIntentId).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=? AND intent_id=? AND committed_at IS NULL")
    .get(alpha.householdId, invalidIntentId).n, 1);
  const revokedIntentId = randomBytes(16).toString("hex");
  const revokedBlobId = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,?,1,?,?)")
    .run(alpha.householdId, revokedIntentId, alpha.profileId,
      alpha.scopeId, alpha.keyId, revokedBlobId, alpha.deviceId,
      alpha.session.sessionId, plaintext.length, now, now + 600);
  const revokedEncrypted = await encryptManagedVaultBlobV2(key, plaintext,
    { ...scope, objectId: randomBytes(16).toString("hex") },
    Buffer.from(revokedBlobId, "hex"));
  const revokedWire = Buffer.from(encodeManagedVaultBlobV2(revokedEncrypted));
  db.prepare("UPDATE managed_devices SET state='revoked', " +
    "revoked_at=unixepoch('now') WHERE household_id=? AND id=?")
    .run(alpha.householdId, alpha.deviceId);
  assert.equal((await fetch(`${base}${path(alpha,
    revokedIntentId, revokedBlobId)}`, { method: "POST",
    headers: headers(alpha), body: revokedWire })).status, 401);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=? AND intent_id=?")
    .get(alpha.householdId, revokedIntentId).n, 0);
  assert.equal((await fetch(receiptUrl, { method: "POST",
    headers: headers(alpha, false) })).status, 401);
  db.prepare("UPDATE managed_sessions SET revoked_at=unixepoch('now') " +
    "WHERE household_id=? AND id=?")
    .run(alpha.householdId, alpha.session.sessionId);
  assert.equal(await sessions.findByTokenSha256(alpha.tokenSha256), null);
  assert.equal((await fetch(receiptUrl, { method: "POST",
    headers: headers(alpha, false) })).status, 401);
  const betaKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 },
    false, ["encrypt", "decrypt"]);
  const betaEncrypted = await encryptManagedVaultBlobV2(betaKey,
    new Uint8Array(0), { householdId: beta.householdId,
      careProfileId: beta.profileId, opaqueScopeId: beta.scopeId,
      objectId: randomBytes(16).toString("hex"), keyEpoch: 1,
      purpose: "day-snapshot", revision: 1 },
    Buffer.from(beta.blobId, "hex"));
  db.prepare("UPDATE managed_sessions SET revoked_at=unixepoch('now') " +
    "WHERE household_id=? AND id=?")
    .run(beta.householdId, beta.session.sessionId);
  assert.equal((await fetch(`${base}${path(beta)}`, { method: "POST",
    headers: headers(beta),
    body: Buffer.from(encodeManagedVaultBlobV2(betaEncrypted)) })).status, 401);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=?").get(beta.householdId).n, 0);
  const reportReader = new Database(dbPath,
    { fileMustExist: true, readonly: true });
  try {
    reportReader.pragma("foreign_keys = ON");
    reportReader.pragma("trusted_schema = OFF");
    const report = await inspectExpiredManagedLeases({ db: reportReader,
      objectRoot, asOfUnixSeconds: now + 601 });
    assert.equal(report.committedWireBytes, wire.byteLength);
    assert.equal(report.uncommittedLeaseBytes, 65);
    assert.equal(report.logicalOccupancyBytes, wire.byteLength + 65);
    assert.equal(report.objectInventory.missingCommitted.length, 0);
    assert.equal(report.objectInventory.corruptCommitted.length, 0);
  } finally { reportReader.close(); }
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  process.stdout.write(`PASS: fictional browser-crypto module under Node → real Express upload/receipt → SQLite/private ciphertext; cross-family, origin, CSRF, malformed, device and session revocation denied. Synthetic fixture retained at ${testRoot}\n`);
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
}
