import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { issueCsrfToken, issueSessionToken } from
  "../dist/auth/cookieSession.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";

// Exact, previously approved empty fictional v10 source only. The copy is a
// separate private synthetic test DB; no migration or family data is touched.
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

const id = (byte) => byte.repeat(32);
const now = Math.floor(Date.now() / 1000);
const raceRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-quota-race-"));
const racePath = join(raceRoot, "managed.sqlite3");
await copyFile(sourcePath, racePath);
await chmod(racePath, 0o600);
const db = new Database(racePath, { fileMustExist: true, timeout: 5_000 });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
db.pragma("main.synchronous = EXTRA");
assertManagedSchema(db);
assert.equal(db.prepare("SELECT count(*) AS n FROM managed_families").get().n, 0);

function seedFamily(byte, accountByte) {
  const householdId = id(byte);
  const accountId = id(accountByte);
  const sessionId = id("3");
  const deviceId = id("4");
  const profileId = id("5");
  const scopeId = id("6");
  const keyId = id("7");
  const intentId = id("8");
  const blobId = id("9");
  const token = issueSessionToken();
  const csrfSecret = randomBytes(32);
  const encryptionPublicKey = randomBytes(32);
  const signingPublicKey = randomBytes(32);
  const enrollmentId = id("a");
  const bindingChallengeId = id("b");
  const keyCommitment = randomBytes(32);
  db.prepare("INSERT INTO managed_families VALUES (?,'active',?)")
    .run(householdId, now);
  db.prepare("INSERT INTO managed_accounts " +
    "(id,login_email,password_hash,state,email_verified_at,created_at) " +
    "VALUES (?,?,?,'active',?,?)")
    .run(accountId, `fictional-race-${byte}@example.invalid`,
      "fictional-not-a-real-password-hash-placeholder-000000", now, now);
  db.prepare("INSERT INTO managed_memberships " +
    "(household_id,account_id,member_kind,role,state,created_at) " +
    "VALUES (?,?,'adult','owner','active',?)")
    .run(householdId, accountId, now);
  db.prepare("INSERT INTO managed_sessions " +
    "(household_id,id,account_id,token_sha256,csrf_secret," +
    "account_auth_version,membership_auth_version,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,1,?,?)")
    .run(householdId, sessionId, accountId,
      Buffer.from(token.sha256, "hex"), csrfSecret, now, now + 3600);
  db.prepare("INSERT INTO managed_enrollment_challenges " +
    "(household_id,id,account_id,session_id,challenge_sha256," +
    "encryption_public_key,signing_public_key,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)")
    .run(householdId, enrollmentId, accountId, sessionId, randomBytes(32),
      encryptionPublicKey, signingPublicKey, now, now + 600);
  db.prepare("INSERT INTO managed_devices " +
    "(household_id,id,account_id,enrollment_challenge_id,state," +
    "encryption_public_key,signing_public_key,created_at) " +
    "VALUES (?,?,?,?,'pending',?,?,?)")
    .run(householdId, deviceId, accountId, enrollmentId,
      encryptionPublicKey, signingPublicKey, now);
  db.prepare("UPDATE managed_enrollment_challenges SET consumed_at=?, " +
    "proof_signature=? WHERE household_id=? AND id=?")
    .run(now, randomBytes(64), householdId, enrollmentId);
  db.prepare("UPDATE managed_devices SET state='active', activated_at=? " +
    "WHERE household_id=? AND id=?").run(now, householdId, deviceId);
  db.prepare("INSERT INTO managed_session_device_challenges " +
    "(household_id,id,account_id,session_id,device_id,nonce_sha256," +
    "audience_sha256,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)")
    .run(householdId, bindingChallengeId, accountId, sessionId, deviceId,
      randomBytes(32), randomBytes(32), now, now + 300);
  db.prepare("UPDATE managed_session_device_challenges SET consumed_at=?, " +
    "proof_signature=? WHERE household_id=? AND id=?")
    .run(now, randomBytes(64), householdId, bindingChallengeId);
  db.prepare("INSERT INTO managed_session_device_bindings " +
    "(household_id,session_id,account_id,device_id,challenge_id,bound_at) " +
    "VALUES (?,?,?,?,?,?)")
    .run(householdId, sessionId, accountId, deviceId, bindingChallengeId, now);
  db.prepare("INSERT INTO managed_profiles " +
    "(household_id,id,state,created_by_account_id,created_at) " +
    "VALUES (?,?,'active',?,?)")
    .run(householdId, profileId, accountId, now);
  db.prepare("INSERT INTO managed_scopes " +
    "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
    "VALUES (?,?,?,'day','active',?,?)")
    .run(householdId, profileId, scopeId, deviceId, now);
  let counter = 0;
  let predecessor = null;
  const signedAction = (kind) => {
    counter += 1;
    const payloadSha256 = randomBytes(32);
    const actionSha256 = randomBytes(32);
    db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)")
      .run(householdId, deviceId, counter, kind, payloadSha256,
        predecessor, actionSha256, randomBytes(64), now);
    predecessor = actionSha256;
    return { counter, payloadSha256 };
  };
  // The key/grant signatures are structural invented fixtures; the real
  // ledger still rechecks their resulting relational authority and binding.
  const registration = signedAction("key");
  db.prepare("INSERT INTO managed_key_identities " +
    "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
    "key_commitment,signed_payload_sha256,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,'day',?,?,?,?,?)")
    .run(householdId, profileId, scopeId, keyId, keyCommitment,
      registration.payloadSha256, deviceId, registration.counter, now);
  const activation = signedAction("key");
  db.prepare("INSERT INTO managed_active_key_events " +
    "(household_id,profile_id,scope_id,sequence,previous_sha256," +
    "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
    "key_commitment,registration_sha256,issuer_device_id,session_id," +
    "issuer_counter,created_at) " +
    "VALUES (?,?,?,1,NULL,NULL,NULL,?,?,1,'day',?,?,?,?,?,?)")
    .run(householdId, profileId, scopeId, activation.payloadSha256, keyId,
      keyCommitment, registration.payloadSha256, deviceId, sessionId,
      activation.counter, now);
  db.prepare("INSERT INTO managed_grant_heads " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "head_sha256,capability_mask,updated_at) VALUES (?,?,?,?,0,NULL,0,?)")
    .run(householdId, profileId, scopeId, deviceId, now);
  const grant = signedAction("grant");
  db.prepare("INSERT INTO managed_grant_events " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,NULL,?,3,?,?,?)")
    .run(householdId, profileId, scopeId, deviceId, grant.payloadSha256,
      deviceId, grant.counter, now);
  db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,0,1,?,?)")
    .run(householdId, intentId, profileId, scopeId, keyId, blobId,
      deviceId, sessionId, now, now + 600);
  return { tokenSha256: token.sha256,
    csrfToken: issueCsrfToken(sessionId, csrfSecret), intentId,
    session: { scope: { householdId, userId: accountId },
      sessionId, csrfSecret, expiresAt: now + 3600 } };
}

function waitFor(work, milliseconds = 5_000) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Fictional race timed out")),
      milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function workerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Fictional quota worker exited ${code} before ${type}`));
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

let workers = [];
try {
  db.exec("BEGIN IMMEDIATE");
  let alpha;
  let beta;
  try {
    alpha = seedFamily("1", "2");
    beta = seedFamily("6", "7");
    assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  assert.equal(db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
    "FROM managed_wire_occupancy").get().bytes, 0);
  db.exec("BEGIN IMMEDIATE"); // Hold the writer lock while both workers start.
  const contenders = [alpha, beta].map((fixture) => {
    const worker = new Worker(new URL("./managedGlobalQuotaWorker.mjs",
      import.meta.url), { workerData: { path: racePath, ...fixture } });
    workers.push(worker);
    const ready = workerMessage(worker, "ready");
    const result = workerMessage(worker, "result");
    ready.catch(() => {}); // Observed below after both workers are created.
    result.catch(() => {}); // Keep early worker failure from going unhandled.
    return { worker, ready, result };
  });
  const readyMessages = await waitFor(Promise.all(contenders.map(({ ready }) => ready)));
  assert.ok(readyMessages.every((message) => message?.type === "ready"));
  const attempts = contenders.map(({ worker }) => workerMessage(worker, "attempting"));
  for (const { worker } of contenders) worker.postMessage({ type: "go" });
  const attemptMessages = await waitFor(Promise.all(attempts));
  assert.ok(attemptMessages.every((message) => message?.type === "attempting"));
  db.exec("COMMIT");
  const outcomes = await waitFor(Promise.all(contenders.map(({ result }) => result)));
  assert.deepEqual(outcomes.map((result) => result.status).sort(),
    ["quota-denied", "reserved"]);
  const winner = outcomes.find((result) => result.status === "reserved");
  const loser = outcomes.find((result) => result.status === "quota-denied");
  assert.notEqual(winner.householdId, loser.householdId);
  const intentByHousehold = new Map([alpha, beta].map((fixture) =>
    [fixture.session.scope.householdId, fixture.intentId]));
  const reader = new Database(racePath, { fileMustExist: true, readonly: true });
  try {
    assert.equal(reader.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
      "FROM managed_wire_occupancy").get().bytes, 65);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM managed_staging_leases")
      .get().n, 1);
    const lease = reader.prepare("SELECT household_id, intent_id, reserved_bytes, " +
      "committed_at FROM managed_staging_leases").get();
    assert.equal(lease.household_id, winner.householdId);
    assert.equal(lease.intent_id, intentByHousehold.get(winner.householdId));
    assert.equal(lease.reserved_bytes, 65);
    assert.equal(lease.committed_at, null);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
      "WHERE household_id=? AND intent_id=?")
      .get(loser.householdId, intentByHousehold.get(loser.householdId)).n, 0);
    assert.equal(reader.prepare("SELECT count(*) AS n FROM managed_committed_blobs")
      .get().n, 0);
    for (const [householdId, expected] of [[winner.householdId, 65],
      [loser.householdId, 0]]) {
      assert.equal(reader.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
        "FROM managed_wire_occupancy WHERE household_id=?")
        .get(householdId).bytes, expected);
      assert.equal(reader.prepare("SELECT count(*) AS n " +
        "FROM managed_staging_leases WHERE household_id=?")
        .get(householdId).n, expected === 65 ? 1 : 0);
    }
  } finally { reader.close(); }
  process.stdout.write(`PASS: two fictional worker connections produced one 65-byte lease and one quota denial. Synthetic copy retained at ${racePath}\n`);
} finally {
  try { if (db.inTransaction) db.exec("ROLLBACK"); }
  finally { db.close(); }
  await Promise.all(workers.map((worker) => worker.terminate()));
}
