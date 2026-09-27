import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import { ManagedDraftPairDenied, SqliteDraftPairReservation } from
  "../dist/managed/sqliteDraftPairReservation.js";

if (!parentPort || !workerData) throw new Error("Fictional worker only");
const db = new Database(workerData.path, { fileMustExist: true,
  timeout: 15_000 });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
db.pragma("synchronous = EXTRA");
const service = new SqliteDraftPairReservation(db, 4096,
  workerData.globalCap);
parentPort.postMessage({ type: "ready" });
parentPort.once("message", (message) => {
  if (message?.type !== "go") throw new Error("Unexpected fictional worker action");
  parentPort.postMessage({ type: "attempting" });
  try {
    const result = service.openPairedLeases({
      tokenSha256: workerData.tokenSha256,
      csrfToken: workerData.csrfToken,
      reservationId: workerData.reservationId,
    });
    parentPort.postMessage({ type: "result", status: "reserved",
      reservedBytes: result.reservedBytes });
  } catch (error) {
    if (!(error instanceof ManagedDraftPairDenied)) throw error;
    parentPort.postMessage({ type: "result", status: "denied" });
  } finally { db.close(); }
});
