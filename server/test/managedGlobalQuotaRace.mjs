import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";

import Database from "better-sqlite3";

import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

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
    alpha = seedFictionalManagedFamily(db, "1", "2", now);
    beta = seedFictionalManagedFamily(db, "6", "7", now);
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
