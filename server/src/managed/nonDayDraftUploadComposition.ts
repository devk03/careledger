import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import type Database from "better-sqlite3";

import type { ManagedVaultUploadStore } from "./ciphertextAdmission.js";
import { SqliteNonDayDraftUploadLedger } from
  "./sqliteNonDayDraftUploadLedger.js";
import { createStagedManagedVaultUploadStore } from "./stagedUploadStore.js";
import type { ManagedUploadReceiptReader } from "./uploadReceipt.js";

export class NonDayDraftUploadCompositionUnavailable extends Error {
  constructor() { super("Managed draft upload composition unavailable"); }
}

/**
 * Unmounted, draft-only counterpart to the day upload composition. Both
 * reserved leases must already exist before the first object write. Do not
 * combine this with the day router until a reviewed intent dispatcher and
 * abandoned-lease reconciliation exist.
 */
export function createNonDayDraftUploadComposition(input: {
  connection: Database.Database;
  objectRoot: string;
  maxStoredBytesPerFamily: number;
  maxGlobalStoredBytes: number;
}): Readonly<{ store: ManagedVaultUploadStore;
  receipts: ManagedUploadReceiptReader }> {
  let objectRoot: string;
  try {
    if (typeof input.objectRoot !== "string" ||
      !isAbsolute(input.objectRoot))
      throw new NonDayDraftUploadCompositionUnavailable();
    const info = lstatSync(input.objectRoot);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new NonDayDraftUploadCompositionUnavailable();
    objectRoot = realpathSync(input.objectRoot);
  } catch { throw new NonDayDraftUploadCompositionUnavailable(); }
  const ledger = new SqliteNonDayDraftUploadLedger(input.connection,
    input.maxStoredBytesPerFamily, input.maxGlobalStoredBytes);
  return Object.freeze({
    store: createStagedManagedVaultUploadStore({ objectRoot, ledger }),
    receipts: Object.freeze({ readReceipt: (request:
      Parameters<ManagedUploadReceiptReader["readReceipt"]>[0]) =>
      ledger.readReceipt(request) }),
  });
}
