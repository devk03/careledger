import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

// Read only the exact empty fictional v10 database created with the separate
// approval. All invented rows and races run in a retained private copy.
const EMPTY_SHA256 =
  "192af3bf39723c238659a61c3b6508be7d3ba0d88b23a6cb325d99e52a0d0df4";
const sourcePath = process.argv[2];
assert.equal(process.env.ADENO_APPROVED_FICTIONAL_MIGRATION, "1");
assert.notEqual(process.env.NODE_ENV, "production");
assert.equal(Object.keys(process.env).some(name => name.startsWith("RAILWAY_")),
  false);
assert.equal(typeof sourcePath, "string");
const sourceParent = realpathSync(dirname(sourcePath));
assert.equal(basename(sourcePath), "managed.sqlite3");
assert.match(basename(sourceParent), /^adeno-fictional-managed-[A-Za-z0-9]+$/u);
assert.equal(dirname(sourceParent), realpathSync(tmpdir()));
assert.equal(realpathSync(sourcePath), join(sourceParent, "managed.sqlite3"));
assert.equal(statSync(sourceParent).mode & 0o077, 0);
assert.equal(statSync(sourcePath).mode & 0o077, 0);
assert.equal(existsSync(`${sourcePath}-wal`), false);
assert.equal(existsSync(`${sourcePath}-shm`), false);
assert.equal(createHash("sha256").update(readFileSync(sourcePath))
  .digest("hex"), EMPTY_SHA256);

const copyRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-grant-race-"));
const copyPath = join(copyRoot, "managed.sqlite3");
await copyFile(sourcePath, copyPath);
await chmod(copyPath, 0o600);
const db = new Database(copyPath, { fileMustExist: true, timeout: 5_000 });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
assertManagedSchema(db);
assert.equal(db.prepare("SELECT count(*) AS n FROM managed_families")
  .get().n, 0);

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
      reject(new Error(`Fictional grant worker exited ${code} before ${type}`));
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
}

function within(promise, milliseconds = 5_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Fictional grant race timed out")),
      milliseconds);
  })]).finally(() => clearTimeout(timer));
}

const workers = [];
try {
  const now = Math.floor(Date.now() / 1000);
  db.exec("BEGIN IMMEDIATE");
  let fixture;
  let previousHead;
  const contenders = [];
  try {
    fixture = seedFictionalManagedFamily(db, "1", "2", now);
    const head = db.prepare("SELECT sequence, head_sha256 FROM " +
      "managed_grant_heads WHERE household_id=? AND profile_id=? " +
      "AND scope_id=? AND subject_device_id=?")
      .get(fixture.householdId, fixture.profileId, fixture.scopeId,
        fixture.deviceId);
    assert.equal(head.sequence, 1);
    previousHead = Buffer.from(head.head_sha256);
    let priorAction = db.prepare("SELECT counter, action_sha256 FROM " +
      "managed_signed_actions WHERE household_id=? AND device_id=? " +
      "ORDER BY counter DESC LIMIT 1")
      .get(fixture.householdId, fixture.deviceId);
    assert.equal(priorAction.counter, 3);
    for (const mask of [0, 1, 3]) {
      const counter = priorAction.counter + 1;
      const eventSha256 = randomBytes(32);
      const actionSha256 = randomBytes(32);
      db.prepare("INSERT INTO managed_signed_actions " +
        "(household_id,device_id,counter,action_kind,payload_sha256," +
        "previous_action_sha256,action_sha256,signature,created_at) " +
        "VALUES (?,?,?,'grant',?,?,?,?,?)")
        .run(fixture.householdId, fixture.deviceId, counter,
          eventSha256, priorAction.action_sha256, actionSha256,
          randomBytes(64), now);
      contenders.push({ issuerCounter: counter,
        eventSha256: eventSha256.toString("hex"), capabilityMask: mask });
      priorAction = { counter, action_sha256: actionSha256 };
    }
    assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }

  db.exec("BEGIN IMMEDIATE"); // Hold the writer lock while workers start.
  const racing = contenders.slice(0, 2).map((candidate) => {
    const worker = new Worker(new URL("./managedGrantHeadRaceWorker.mjs",
      import.meta.url), { workerData: { path: copyPath,
      householdId: fixture.householdId, profileId: fixture.profileId,
      scopeId: fixture.scopeId, deviceId: fixture.deviceId,
      previousSha256: previousHead.toString("hex"),
      createdAt: now, ...candidate } });
    workers.push(worker);
    const ready = workerMessage(worker, "ready");
    const result = workerMessage(worker, "result");
    ready.catch(() => {});
    result.catch(() => {});
    return { worker, ready, result };
  });
  await within(Promise.all(racing.map(item => item.ready)));
  const contention = racing.map(item => workerMessage(item.worker,
    "contended"));
  for (const item of racing) item.worker.postMessage({ type: "probe" });
  await within(Promise.all(contention));
  const attempts = racing.map(item => workerMessage(item.worker, "attempting"));
  for (const item of racing) item.worker.postMessage({ type: "go" });
  await within(Promise.all(attempts));
  db.exec("COMMIT");
  const outcomes = await within(Promise.all(racing.map(item => item.result)));
  assert.deepEqual(outcomes.map(item => item.status).sort(),
    ["committed", "stale"]);
  const winner = outcomes.find(item => item.status === "committed");
  const loser = outcomes.find(item => item.status === "stale");
  assert.equal(loser.error, "stale grant sequence");

  const reader = new Database(copyPath, { readonly: true, fileMustExist: true });
  try {
    const head = reader.prepare("SELECT sequence, head_sha256, " +
      "capability_mask FROM managed_grant_heads WHERE household_id=? " +
      "AND profile_id=? AND scope_id=? AND subject_device_id=?")
      .get(fixture.householdId, fixture.profileId, fixture.scopeId,
        fixture.deviceId);
    assert.equal(head.sequence, 2);
    assert.equal(Buffer.from(head.head_sha256).toString("hex"),
      winner.eventSha256);
    assert.equal(head.capability_mask, winner.capabilityMask);
    const events = reader.prepare("SELECT sequence, event_sha256 FROM " +
      "managed_grant_events WHERE household_id=? AND profile_id=? " +
      "AND scope_id=? AND subject_device_id=? ORDER BY sequence")
      .all(fixture.householdId, fixture.profileId, fixture.scopeId,
        fixture.deviceId);
    assert.deepEqual(events.map(event => event.sequence), [1, 2]);
    assert.equal(Buffer.from(events[1].event_sha256).toString("hex"),
      winner.eventSha256);
  } finally { reader.close(); }

  // A unique sequence key alone would not catch this: a new sequence 3 must
  // still be rejected if it cites the old sequence-1 predecessor.
  const stale = contenders[2];
  assert.throws(() => db.prepare("INSERT INTO managed_grant_events " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,3,?,?,?,?,?,?)")
    .run(fixture.householdId, fixture.profileId, fixture.scopeId,
      fixture.deviceId, previousHead, Buffer.from(stale.eventSha256, "hex"),
      stale.capabilityMask, fixture.deviceId, stale.issuerCounter, now),
  /stale grant predecessor/u);
  assert.equal(db.prepare("SELECT sequence FROM managed_grant_heads " +
    "WHERE household_id=? AND profile_id=? AND scope_id=? " +
    "AND subject_device_id=?")
    .get(fixture.householdId, fixture.profileId, fixture.scopeId,
      fixture.deviceId).sequence, 2);
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(createHash("sha256").update(readFileSync(sourcePath))
    .digest("hex"), EMPTY_SHA256);
  process.stdout.write("PASS: two fictional workers first saw SQLITE_BUSY; " +
    "one grant won, while stale sequence and predecessor were denied. " +
    `Copy retained at ${copyPath}\n`);
} finally {
  try { if (db.inTransaction) db.exec("ROLLBACK"); }
  finally { db.close(); }
  await Promise.all(workers.map(worker => worker.terminate()));
}
