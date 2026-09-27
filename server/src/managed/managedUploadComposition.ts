import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

import type Database from "better-sqlite3";

import type { ManagedVaultUploadStore } from "./ciphertextAdmission.js";
import { SqliteManagedUploadLedger } from "./sqliteUploadLedger.js";
import { createStagedManagedVaultUploadStore } from "./stagedUploadStore.js";
import type { ManagedUploadReceiptReader } from "./uploadReceipt.js";

export class ManagedUploadCompositionUnavailable extends Error {
  constructor() { super("Managed ciphertext upload composition unavailable"); }
}

/**
 * Unmounted production wiring for the only supported day-blob publication
 * path: private create-only objects -> exact re-read wire proof -> current
 * SQLite authority/nonce/lease transaction. The borrowed connection remains
 * caller-owned. Do not mount until orphan reconciliation, intent issuance,
 * global disk quota and crash recovery have passed their launch gates.
 */
export function createManagedUploadComposition(input: {
  connection: Database.Database;
  objectRoot: string;
  maxStoredBytesPerFamily: number;
}): Readonly<{ store: ManagedVaultUploadStore;
  receipts: ManagedUploadReceiptReader }> {
  let objectRoot: string;
  try {
    if (typeof input.objectRoot !== "string" ||
      !isAbsolute(input.objectRoot))
      throw new ManagedUploadCompositionUnavailable();
    const info = lstatSync(input.objectRoot);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new ManagedUploadCompositionUnavailable();
    objectRoot = realpathSync(input.objectRoot);
  } catch { throw new ManagedUploadCompositionUnavailable(); }
  const ledger = new SqliteManagedUploadLedger({ connection: input.connection },
    input.maxStoredBytesPerFamily);
  return Object.freeze({
    store: createStagedManagedVaultUploadStore({ objectRoot, ledger }),
    receipts: Object.freeze({ readReceipt: (request:
      Parameters<ManagedUploadReceiptReader["readReceipt"]>[0]) =>
      ledger.readReceipt(request) }),
  });
}
