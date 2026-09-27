import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

if (!parentPort || !workerData || typeof workerData.path !== "string")
  throw new Error("Fictional grant worker requires a private database");

const db = new Database(workerData.path, { fileMustExist: true,
  timeout: 5_000 });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
parentPort.postMessage({ type: "ready" });
parentPort.once("message", (probe) => {
  try {
    if (probe?.type !== "probe") throw new Error("Invalid lock probe");
    db.pragma("busy_timeout = 0");
    try {
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
      throw new Error("Fictional coordinator lock was not held");
    } catch (error) {
      if (error?.code !== "SQLITE_BUSY") throw error;
    }
    db.pragma("busy_timeout = 5000");
    parentPort.postMessage({ type: "contended" });
    parentPort.once("message", runRace);
  } catch (error) {
    parentPort.postMessage({ type: "result", status: "error",
      error: error?.message ?? "unknown" });
    db.close();
  }
});

function runRace(message) {
  try {
    if (message?.type !== "go") throw new Error("Invalid race signal");
    parentPort.postMessage({ type: "attempting" });
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO managed_grant_events " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,2,?,?,?,?,?,?)")
      .run(workerData.householdId, workerData.profileId,
        workerData.scopeId, workerData.deviceId,
        Buffer.from(workerData.previousSha256, "hex"),
        Buffer.from(workerData.eventSha256, "hex"),
        workerData.capabilityMask, workerData.deviceId,
        workerData.issuerCounter, workerData.createdAt);
    db.exec("COMMIT");
    parentPort.postMessage({ type: "result", status: "committed",
      eventSha256: workerData.eventSha256,
      capabilityMask: workerData.capabilityMask });
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    parentPort.postMessage({ type: "result",
      status: error?.message === "stale grant sequence" ? "stale" : "error",
      error: error?.message ?? "unknown" });
  } finally { db.close(); }
}
