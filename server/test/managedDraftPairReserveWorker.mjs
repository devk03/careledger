import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import { SqliteDraftPairReservation } from
  "../dist/managed/sqliteDraftPairReservation.js";

if (!parentPort || !workerData) throw new Error("Fictional worker only");
const db = new Database(workerData.path, { fileMustExist: true,
  timeout: 15_000 });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
db.pragma("synchronous = EXTRA");
const service = new SqliteDraftPairReservation(db, 4096, 8192);
parentPort.postMessage({ type: "ready" });
parentPort.once("message", (message) => {
  if (message?.type !== "go") throw new Error("Unexpected fictional worker action");
  parentPort.postMessage({ type: "attempting" });
  try {
    const result = service.reserve({
      tokenSha256: workerData.tokenSha256,
      csrfToken: workerData.csrfToken,
      reservationId: workerData.reservationId,
      profileId: workerData.profileId,
      scopeId: workerData.scopeId,
      keyId: workerData.keyId, epoch: 1,
    });
    parentPort.postMessage({ type: "result", result });
  } finally { db.close(); }
});
