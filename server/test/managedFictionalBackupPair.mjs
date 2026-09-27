import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";

import { encodeManagedVaultBlobV2, MANAGED_VAULT_CHUNK_BYTES,
  MANAGED_VAULT_FORMAT_V2 } from "@adeno/contracts";
import { createManagedUploadComposition } from
  "../dist/managed/managedUploadComposition.js";
import { SqliteManagedUploadLedger } from
  "../dist/managed/sqliteUploadLedger.js";
import { readCiphertextChunk, storeCiphertextChunk } from
  "../dist/managed/ciphertextObjectStore.js";
import { createOfflineManagedBackupPair, OfflineManagedBackupPairError,
  restoreOfflineManagedBackupPair, verifyOfflineManagedBackupPair } from
  "../dist/managed/offlineBackupPair.js";
import { readCommittedCiphertextReferences } from
  "../dist/managed/committedCiphertextReferences.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

// Exact approved empty fictional source only. All seeded data is written to a
// private copy; no migration, production DB or family record is touched.
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

const fixturesRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-pair-"));
const results = [];
for (const mode of ["delete", "wal"]) {
  const root = await mkdtemp(join(fixturesRoot, `mode-${mode}-`));
  const dbPath = join(root, "managed.sqlite3");
  const objectRoot = await mkdtemp(join(root, "objects-"));
  const backupRoot = await mkdtemp(join(root, "backups-"));
  await copyFile(sourcePath, dbPath);
  await chmod(dbPath, 0o600);
  const db = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
  let walReader;
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = OFF");
    if (mode === "wal") {
      assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
      db.pragma("synchronous = FULL");
    } else db.pragma("synchronous = EXTRA");
    assertManagedSchema(db);
    if (mode === "wal") {
      walReader = new Database(dbPath, { fileMustExist: true, readonly: true });
      walReader.exec("BEGIN");
      assert.equal(walReader.prepare("SELECT count(*) AS n FROM " +
        "managed_committed_blobs").get().n, 0);
    }
    const now = Math.floor(Date.now() / 1000);
    const fixtures = db.transaction(() => [
      seedFictionalManagedFamily(db, "1", "2", now),
      seedFictionalManagedFamily(db, "6", "7", now),
    ]).immediate();
    const composed = createManagedUploadComposition({ connection: db,
      objectRoot, maxStoredBytesPerFamily: 1024 * 1024,
      maxGlobalStoredBytes: 2 * 1024 * 1024 });
    for (let index = 0; index < fixtures.length; index += 1) {
      const fixture = fixtures[index];
      const iv = Buffer.alloc(12, index + 1);
      const ciphertext = Buffer.alloc(16, index + 8);
      const wire = encodeManagedVaultBlobV2({
        format: MANAGED_VAULT_FORMAT_V2,
        blobId: Buffer.from(fixture.blobId, "hex"), plaintextSize: 0,
        chunkSize: MANAGED_VAULT_CHUNK_BYTES,
        chunks: [{ iv, ciphertext: ciphertext.buffer.slice(
          ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) }],
      });
      const opened = await composed.store.open({ session: fixture.session,
        preflight: { tokenSha256: fixture.tokenSha256,
          csrfToken: fixture.csrfToken }, intentId: fixture.intentId,
        signal: new AbortController().signal });
      assert.ok(opened);
      const header = { wireVersion: 2, blobId: fixture.blobId,
        plaintextSize: 0, chunkCount: 1, expectedWireBytes: wire.byteLength };
      await opened.sink.begin(header);
      await opened.sink.append({ index: 0, iv, ciphertext });
      await opened.sink.commit(header,
        createHash("sha256").update(wire).digest("hex"),
        new AbortController().signal);
    }
    // The non-day runtime is not mounted. Seed a structurally valid fictional
    // source commit so the paired backup must preserve its actual disk chunk.
    const owner = fixtures[1];
    const sourceScopeId = randomBytes(16).toString("hex");
    const sourceKeyId = randomBytes(16).toString("hex");
    const sourceIntentId = randomBytes(16).toString("hex");
    const sourceBlobId = randomBytes(16).toString("hex");
    const sourceObjectId = randomBytes(16).toString("hex");
    const sourceCommitment = randomBytes(32);
    const sourceAt = Math.floor(Date.now() / 1000);
    const sourceCiphertext = Buffer.alloc(16, 0x46);
    const sourceNonce = randomBytes(12);
    const sourceStored = await storeCiphertextChunk(objectRoot,
      owner.householdId, sourceCiphertext);
    const appendAction = (kind) => {
      const prior = db.prepare("SELECT counter, action_sha256 AS hash " +
        "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
        "ORDER BY counter DESC LIMIT 1")
        .get(owner.householdId, owner.deviceId);
      const payload = randomBytes(32);
      const counter = prior.counter + 1;
      db.prepare("INSERT INTO managed_signed_actions " +
        "(household_id,device_id,counter,action_kind,payload_sha256," +
        "previous_action_sha256,action_sha256,signature,created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?)")
        .run(owner.householdId, owner.deviceId, counter, kind, payload,
          prior.hash, randomBytes(32), randomBytes(64), sourceAt);
      return { counter, payload };
    };
    db.prepare("INSERT INTO managed_scopes " +
      "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
      "VALUES (?,?,?,'source','active',?,?)")
      .run(owner.householdId, owner.profileId, sourceScopeId,
        owner.deviceId, sourceAt);
    const registration = appendAction("key");
    db.prepare("INSERT INTO managed_key_identities " +
      "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
      "key_commitment,signed_payload_sha256,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,1,'source',?,?,?,?,?)")
      .run(owner.householdId, owner.profileId, sourceScopeId,
        sourceKeyId, sourceCommitment, registration.payload,
        owner.deviceId, registration.counter, sourceAt);
    const activation = appendAction("key");
    db.prepare("INSERT INTO managed_active_key_events " +
      "(household_id,profile_id,scope_id,sequence,previous_sha256," +
      "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
      "key_commitment,registration_sha256,issuer_device_id,session_id," +
      "issuer_counter,created_at) VALUES " +
      "(?,?,?,1,NULL,NULL,NULL,?,?,1,'source',?,?,?,?,?,?)")
      .run(owner.householdId, owner.profileId, sourceScopeId,
        activation.payload, sourceKeyId, sourceCommitment,
        registration.payload, owner.deviceId, owner.session.sessionId,
        activation.counter, sourceAt);
    db.prepare("INSERT INTO managed_grant_heads " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "head_sha256,capability_mask,updated_at) VALUES (?,?,?,?,0,NULL,0,?)")
      .run(owner.householdId, owner.profileId, sourceScopeId,
        owner.deviceId, sourceAt);
    const grant = appendAction("grant");
    db.prepare("INSERT INTO managed_grant_events " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,1,NULL,?,3,?,?,?)")
      .run(owner.householdId, owner.profileId, sourceScopeId,
        owner.deviceId, grant.payload, owner.deviceId, grant.counter,
        sourceAt);
    db.prepare("INSERT INTO managed_non_day_upload_intents " +
      "(household_id,id,profile_id,scope_id,key_id,epoch,purpose,role," +
      "draft_reservation_id,object_id,aad_revision,wire_version,blob_id," +
      "writer_device_id,session_id,plaintext_bytes,chunk_count,created_at,expires_at) " +
      "VALUES (?,?,?,?,?,1,'source','original',NULL,?,1,2,?,?,?,0,1,?,?)")
      .run(owner.householdId, sourceIntentId, owner.profileId,
        sourceScopeId, sourceKeyId, sourceObjectId, sourceBlobId,
        owner.deviceId, owner.session.sessionId, sourceAt, sourceAt + 600);
    db.prepare("INSERT INTO managed_non_day_staging_leases " +
      "(household_id,intent_id,attempt_id,reserved_bytes,opened_at) " +
      "VALUES (?,?,?,?,?)")
      .run(owner.householdId, sourceIntentId,
        randomBytes(16).toString("hex"), 65, sourceAt);
    db.prepare("INSERT INTO managed_non_day_nonce_reservations " +
      "(household_id,key_id,epoch,nonce,intent_id,chunk_index,reserved_at) " +
      "VALUES (?,?,1,?,?,0,?)")
      .run(owner.householdId, sourceKeyId, sourceNonce,
        sourceIntentId, sourceAt);
    db.prepare("INSERT INTO managed_non_day_blob_chunks " +
      "(household_id,intent_id,chunk_index,nonce,storage_object_id," +
      "ciphertext_bytes,ciphertext_sha256) VALUES (?,?,0,?,?,16,?)")
      .run(owner.householdId, sourceIntentId, sourceNonce,
        sourceStored.storageObjectId,
        Buffer.from(sourceStored.sha256, "hex"));
    const sourceWire = encodeManagedVaultBlobV2({
      format: MANAGED_VAULT_FORMAT_V2,
      blobId: Buffer.from(sourceBlobId, "hex"), plaintextSize: 0,
      chunkSize: MANAGED_VAULT_CHUNK_BYTES,
      chunks: [{ iv: sourceNonce, ciphertext: sourceCiphertext.buffer.slice(
        sourceCiphertext.byteOffset,
        sourceCiphertext.byteOffset + sourceCiphertext.byteLength) }],
    });
    db.prepare("INSERT INTO managed_non_day_committed_blobs " +
      "(household_id,blob_id,intent_id,profile_id,scope_id,key_id,epoch," +
      "purpose,role,object_id,aad_revision,writer_device_id,wire_version," +
      "wire_sha256,wire_bytes,committed_at) VALUES " +
      "(?,?,?,?,?,?,1,'source','original',?,1,?,2,?,?,?)")
      .run(owner.householdId, sourceBlobId, sourceIntentId,
        owner.profileId, sourceScopeId, sourceKeyId, sourceObjectId,
        owner.deviceId, createHash("sha256").update(sourceWire).digest(),
        sourceWire.byteLength, sourceAt);
    const failedIntentId = randomBytes(16).toString("hex");
    const failedBlobId = randomBytes(16).toString("hex");
    const failedOwner = fixtures[0];
    db.prepare("INSERT INTO managed_upload_intents " +
      "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
      "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
      "chunk_count,created_at,expires_at) " +
      "VALUES (?,?,?,?,?,1,'day',2,?,?,?,0,1,?,?)")
      .run(failedOwner.householdId, failedIntentId,
        failedOwner.profileId, failedOwner.scopeId,
        failedOwner.keyId, failedBlobId, failedOwner.deviceId,
        failedOwner.session.sessionId, sourceAt, sourceAt + 600);
    const failedLedger = new SqliteManagedUploadLedger({ connection: db },
      1024 * 1024, 2 * 1024 * 1024);
    try {
      assert.ok(await failedLedger.openForStaging({
        session: failedOwner.session, tokenSha256: failedOwner.tokenSha256,
        csrfToken: failedOwner.csrfToken, intentId: failedIntentId,
        signal: new AbortController().signal,
      }));
    } finally { failedLedger.close(); }
    const orphan = await storeCiphertextChunk(objectRoot,
      fixtures[0].session.scope.householdId, Buffer.alloc(18, 0xee));
    assert.equal(db.prepare("SELECT count(*) AS n FROM managed_committed_blobs")
      .get().n, 2);
    assert.equal(db.prepare("SELECT count(*) AS n FROM " +
      "managed_non_day_committed_blobs").get().n, 1);
    assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
    db.close(); // No active writer; the WAL reader holds committed frames.
    if (mode === "wal") {
      assert.equal(existsSync(`${dbPath}-wal`), true);
      assert.ok(statSync(`${dbPath}-wal`).size > 0);
      // Test-only raw main-file copy proves new rows are still in WAL. The
      // backup implementation uses SQLite's online API, never this copy.
      const mainOnlyPath = join(root, "main-file-probe.sqlite3");
      await copyFile(dbPath, mainOnlyPath);
      await chmod(mainOnlyPath, 0o600);
      const mainOnly = new Database(mainOnlyPath,
        { fileMustExist: true, readonly: true });
      try { assert.equal(mainOnly.prepare("SELECT count(*) AS n FROM " +
        "managed_committed_blobs").get().n, 0); }
      finally { mainOnly.close(); }
    }

    const snapshotId = randomBytes(16).toString("hex");
    const proof = await createOfflineManagedBackupPair({ sourceDbPath: dbPath,
      sourceObjectRoot: objectRoot, backupRoot, snapshotId });
    assert.equal(proof.objectCount, 3);
    assert.equal(proof.objectBytes, 48);
    assert.deepEqual(await verifyOfflineManagedBackupPair({ backupRoot,
      snapshotId, expectedPairSha256: proof.pairSha256 }), proof);
    const objectNames = await readdir(join(backupRoot, snapshotId,
      "objects", snapshotId));
    assert.equal(objectNames.length, 4); // Three referenced chunks + manifest.
    assert.equal(objectNames.some((name) => name.includes(orphan.storageObjectId)),
      false);
    assert.equal(objectNames.some((name) => name.startsWith("pending-")), false);
    const restoreParent = await mkdtemp(join(root, "restore-"));
    const restored = await restoreOfflineManagedBackupPair({ backupRoot,
      snapshotId, expectedPairSha256: proof.pairSha256,
      targetParent: restoreParent });
    assert.equal(restored.objectCount, 3);
    const restoredDb = new Database(restored.databasePath,
      { fileMustExist: true, readonly: true });
    let restoredReferences;
    try {
      restoredDb.pragma("foreign_keys = ON");
      restoredDb.pragma("trusted_schema = OFF");
      assertManagedSchema(restoredDb);
      assert.equal(restoredDb.prepare("PRAGMA integrity_check").get()
        .integrity_check, "ok");
      assert.equal(restoredDb.prepare("PRAGMA foreign_key_check").get(),
        undefined);
      assert.equal(restoredDb.prepare("SELECT count(*) AS n FROM " +
        "managed_staging_leases WHERE household_id=? AND intent_id=? " +
        "AND committed_at IS NULL")
        .get(failedOwner.householdId, failedIntentId).n, 1);
      restoredReferences = readCommittedCiphertextReferences(restoredDb);
    } finally { restoredDb.close(); }
    assert.equal(restoredReferences.length, 3);
    assert.equal(restoredReferences.some((reference) =>
      reference.storageObjectId === sourceStored.storageObjectId), true);
    for (const reference of restoredReferences)
      assert.equal((await readCiphertextChunk(restored.objectRoot,
        reference.householdId, reference.storageObjectId,
        reference.sha256, reference.byteSize)).byteLength, 16);
    await assert.rejects(readCiphertextChunk(restored.objectRoot,
      fixtures[0].session.scope.householdId, orphan.storageObjectId,
      orphan.sha256, orphan.byteSize));
    await assert.rejects(readCiphertextChunk(restored.objectRoot,
      fixtures[1].session.scope.householdId,
      restoredReferences[0].storageObjectId,
      restoredReferences[0].sha256, restoredReferences[0].byteSize));
    assert.equal(existsSync(join(restored.targetRoot, ".restore-complete")), true);
    await assert.rejects(verifyOfflineManagedBackupPair({ backupRoot,
      snapshotId, expectedPairSha256: "0".repeat(64) }),
    OfflineManagedBackupPairError);
    const objectTamperId = randomBytes(16).toString("hex");
    const objectTamperProof = await createOfflineManagedBackupPair({
      sourceDbPath: dbPath, sourceObjectRoot: objectRoot,
      backupRoot, snapshotId: objectTamperId });
    const objectDirectory = join(backupRoot, objectTamperId,
      "objects", objectTamperId);
    const objectName = (await readdir(objectDirectory)).find((name) =>
      name !== "manifest.json");
    assert.ok(objectName);
    const objectPath = join(objectDirectory, objectName);
    await chmod(objectPath, 0o600);
    await writeFile(objectPath, Buffer.alloc(16, 0x77));
    await chmod(objectPath, 0o400);
    await assert.rejects(verifyOfflineManagedBackupPair({ backupRoot,
      snapshotId: objectTamperId,
      expectedPairSha256: objectTamperProof.pairSha256 }),
    OfflineManagedBackupPairError);
    const pairTamperId = randomBytes(16).toString("hex");
    const pairTamperProof = await createOfflineManagedBackupPair({
      sourceDbPath: dbPath, sourceObjectRoot: objectRoot,
      backupRoot, snapshotId: pairTamperId });
    const pairPath = join(backupRoot, pairTamperId, "pair.json");
    await chmod(pairPath, 0o600);
    const pairBytes = Buffer.from(readFileSync(pairPath));
    pairBytes[pairBytes.length - 2] ^= 0x20;
    await writeFile(pairPath, pairBytes);
    await chmod(pairPath, 0o400);
    await assert.rejects(verifyOfflineManagedBackupPair({ backupRoot,
      snapshotId: pairTamperId,
      expectedPairSha256: pairTamperProof.pairSha256 }),
    OfflineManagedBackupPairError);
    const backedDb = join(backupRoot, snapshotId, "managed.sqlite3");
    await chmod(backedDb, 0o600);
    const copy = Buffer.from(readFileSync(backedDb));
    copy[copy.length - 1] ^= 0x7f;
    await writeFile(backedDb, copy);
    await chmod(backedDb, 0o400);
    await assert.rejects(verifyOfflineManagedBackupPair({ backupRoot,
      snapshotId, expectedPairSha256: proof.pairSha256 }),
    OfflineManagedBackupPairError);
    await assert.rejects(restoreOfflineManagedBackupPair({ backupRoot,
      snapshotId, expectedPairSha256: proof.pairSha256,
      targetParent: restoreParent }), OfflineManagedBackupPairError);
    results.push({ mode, backupRoot, objectRoot });
  } finally {
    if (walReader?.open) walReader.close();
    if (db.open) db.close();
  }
}
process.stdout.write(`PASS: fictional DELETE/WAL paired snapshots and fresh restore include two committed families, exclude an orphan, and reject wrong pin/altered DB, object and pair manifest. Synthetic fixtures retained at ${fixturesRoot}\n`);
