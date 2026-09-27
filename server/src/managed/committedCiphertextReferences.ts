import type Database from "better-sqlite3";

import { assertManagedSchema } from "./managedSchemaGuard.js";
import type { CiphertextObjectReference } from "./ciphertextObjectSnapshot.js";

const ID = /^[0-9a-f]{32}$/u;
const MAX_OBJECTS = 100_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024 + 16;

type Row = {
  lineage: "day" | "non_day";
  householdId: string;
  intentId: string;
  expectedChunks: number;
  plaintextBytes: number;
  wireBytes: number;
  chunkIndex: number | null;
  storageObjectId: string | null;
  digest: Buffer | null;
  byteSize: number | null;
};

export class CommittedCiphertextReferencesError extends Error {
  constructor() { super("Committed ciphertext references are unavailable"); }
}

/**
 * List only objects that a committed blob references. Run this against the
 * matching, pinned DB backup/snapshot before object backup; a live database
 * read alone cannot prove the pair is consistent. No object files are read.
 */
export function readCommittedCiphertextReferences(db: Database.Database):
  CiphertextObjectReference[] {
  try {
    return db.transaction(() => {
      assertManagedSchema(db);
      const select = (lineage: "day" | "non_day", blobs: string,
        intents: string, chunks: string) =>
        `SELECT '${lineage}' AS lineage, b.household_id AS householdId, ` +
        "b.intent_id AS intentId, i.chunk_count AS expectedChunks, " +
        "i.plaintext_bytes AS plaintextBytes, b.wire_bytes AS wireBytes, " +
        "c.chunk_index AS chunkIndex, c.storage_object_id AS storageObjectId, " +
        "c.ciphertext_sha256 AS digest, c.ciphertext_bytes AS byteSize " +
        `FROM ${blobs} b LEFT JOIN ${intents} i ` +
        "ON i.household_id=b.household_id AND i.id=b.intent_id " +
        `LEFT JOIN ${chunks} c ON c.household_id=b.household_id ` +
        "AND c.intent_id=b.intent_id";
      const rows = db.prepare<[number], Row>(
        select("day", "managed_committed_blobs", "managed_upload_intents",
          "managed_blob_chunks") + " UNION ALL " +
        select("non_day", "managed_non_day_committed_blobs",
          "managed_non_day_upload_intents", "managed_non_day_blob_chunks") +
        " ORDER BY householdId,lineage,intentId,chunkIndex LIMIT ?",
      ).all(MAX_OBJECTS + 1);
      if (rows.length > MAX_OBJECTS) throw new CommittedCiphertextReferencesError();
      const references: CiphertextObjectReference[] = [];
      const seenObjects = new Set<string>();
      let previous = "";
      let expectedChunks = 0;
      let chunkIndex = 0;
      let totalBytes = 0;
      for (const row of rows) {
        if ((row.lineage !== "day" && row.lineage !== "non_day") ||
          !ID.test(row.householdId) || !ID.test(row.intentId) ||
          !Number.isSafeInteger(row.expectedChunks) || row.expectedChunks < 1 ||
          row.expectedChunks > 100 || !Number.isSafeInteger(row.plaintextBytes) ||
          row.plaintextBytes < 0 || !Number.isSafeInteger(row.wireBytes) ||
          row.wireBytes !== 33 + row.plaintextBytes + 32 * row.expectedChunks ||
          !Number.isSafeInteger(row.chunkIndex) ||
          !ID.test(row.storageObjectId ?? "") || !Buffer.isBuffer(row.digest) ||
          row.digest.length !== 32 || !Number.isSafeInteger(row.byteSize) ||
          row.byteSize === null || row.byteSize < 16 ||
          row.byteSize > MAX_OBJECT_BYTES)
          throw new CommittedCiphertextReferencesError();
        const blob = `${row.householdId}:${row.lineage}:${row.intentId}`;
        if (blob !== previous) {
          if (previous !== "" && chunkIndex !== expectedChunks)
            throw new CommittedCiphertextReferencesError();
          previous = blob;
          expectedChunks = row.expectedChunks;
          chunkIndex = 0;
        }
        if (row.chunkIndex !== chunkIndex ||
          row.expectedChunks !== expectedChunks ||
          row.byteSize !== 16 + Math.max(0, Math.min(1024 * 1024,
            row.plaintextBytes - chunkIndex * 1024 * 1024)))
          throw new CommittedCiphertextReferencesError();
        const identity = `${row.householdId}:${row.storageObjectId}`;
        if (seenObjects.has(identity)) throw new CommittedCiphertextReferencesError();
        seenObjects.add(identity);
        totalBytes += row.byteSize;
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new CommittedCiphertextReferencesError();
        references.push({ householdId: row.householdId,
          storageObjectId: row.storageObjectId!, sha256: row.digest.toString("hex"),
          byteSize: row.byteSize });
        chunkIndex += 1;
      }
      if (previous !== "" && chunkIndex !== expectedChunks)
        throw new CommittedCiphertextReferencesError();
      return references;
    }).deferred();
  } catch { throw new CommittedCiphertextReferencesError(); }
}
