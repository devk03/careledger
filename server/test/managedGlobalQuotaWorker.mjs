import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

import { ManagedVaultUploadDeniedError } from
  "../dist/managed/ciphertextAdmission.js";
import { SqliteManagedUploadLedger } from
  "../dist/managed/sqliteUploadLedger.js";

if (!parentPort || !workerData || typeof workerData.path !== "string")
  throw new Error("Fictional quota worker requires a parent and private DB");

const db = new Database(workerData.path, { fileMustExist: true, timeout: 5_000 });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
db.pragma("main.synchronous = EXTRA");
const ledger = new SqliteManagedUploadLedger({ connection: db }, 130, 65);
parentPort.postMessage({ type: "ready" });
parentPort.once("message", async (message) => {
  try {
    if (message?.type !== "go") throw new Error("Invalid race signal");
    parentPort.postMessage({ type: "attempting" });
    const opened = await ledger.openForStaging({
      session: workerData.session,
      tokenSha256: workerData.tokenSha256,
      csrfToken: workerData.csrfToken,
      intentId: workerData.intentId,
      signal: new AbortController().signal,
    });
    parentPort.postMessage({ type: "result", status: opened ? "reserved" : "missing",
      householdId: workerData.session.scope.householdId });
  } catch (error) {
    parentPort.postMessage(error instanceof ManagedVaultUploadDeniedError ?
      { type: "result", status: "quota-denied",
        householdId: workerData.session.scope.householdId } :
      { type: "result", status: "error", name: error?.name ?? "UnknownError",
        code: error?.code ?? null, message: error?.message ?? null,
        householdId: workerData.session.scope.householdId });
  } finally {
    ledger.close();
    db.close();
  }
});
