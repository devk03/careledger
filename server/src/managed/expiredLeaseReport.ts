import type Database from "better-sqlite3";

import { auditCiphertextObjectInventory,
  type CiphertextObjectInventory } from "./ciphertextObjectInventory.js";
import { readCommittedCiphertextReferences } from
  "./committedCiphertextReferences.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";

const ID = /^[0-9a-f]{32}$/u;
const MAX_LEASE_ROWS = 1_000_000;

type LeaseRow = { lineage: "day" | "non_day"; householdId: string;
  intentId: string; reservedBytes: number; expiresAt: number;
  plaintextBytes: number; chunkCount: number;
  consumedAt: number | null; leaseCommittedAt: number | null;
  blobCommittedAt: number | null; blobWireBytes: number | null };

export type ExpiredLeaseFamilySummary = Readonly<{
  householdId: string;
  expiredDayCount: number;
  expiredNonDayCount: number;
  expiredChargedBytes: number;
  otherUncommittedCount: number;
  otherUncommittedBytes: number;
}>;

export type ExpiredLeaseReport = Readonly<{
  asOfUnixSeconds: number;
  diagnosticOnly: true;
  committedWireBytes: number;
  uncommittedLeaseBytes: number;
  logicalOccupancyBytes: number;
  families: readonly ExpiredLeaseFamilySummary[];
  objectInventory: CiphertextObjectInventory;
}>;

export class ExpiredLeaseReportUnavailable extends Error {
  constructor() {
    super("Managed lease and object inventory is unavailable.");
    this.name = "ExpiredLeaseReportUnavailable";
  }
}

/**
 * Diagnostic only. The caller must fence and drain every writer, then pass a
 * consistent private managed DB snapshot and matching object tree. This does
 * not decide release eligibility, change quota, delete files, or measure
 * allocated disk blocks. In v10 every uncommitted lease stays charged.
 */
export async function inspectExpiredManagedLeases(input: {
  db: Database.Database;
  objectRoot: string;
  asOfUnixSeconds: number;
}): Promise<ExpiredLeaseReport> {
  try {
    if (!Number.isSafeInteger(input.asOfUnixSeconds) ||
      input.asOfUnixSeconds <= 0)
      throw new ExpiredLeaseReportUnavailable();
    const db = input.db;
    if (!db.readonly) throw new ExpiredLeaseReportUnavailable();
    const { rows, committedWireBytes, logicalOccupancyBytes } =
      db.transaction(() => {
        assertManagedSchema(db);
        const rows = db.prepare<[number], LeaseRow>(
          "SELECT 'day' AS lineage, l.household_id AS householdId, " +
          "l.intent_id AS intentId, l.reserved_bytes AS reservedBytes, " +
          "i.expires_at AS expiresAt, i.plaintext_bytes AS plaintextBytes, " +
          "i.chunk_count AS chunkCount, i.consumed_at AS consumedAt, " +
          "l.committed_at AS leaseCommittedAt, " +
          "b.committed_at AS blobCommittedAt, " +
          "b.wire_bytes AS blobWireBytes " +
          "FROM managed_staging_leases l " +
          "JOIN managed_upload_intents i ON i.household_id=l.household_id " +
          "AND i.id=l.intent_id " +
          "LEFT JOIN managed_committed_blobs b " +
          "ON b.household_id=l.household_id AND b.intent_id=l.intent_id " +
          "UNION ALL " +
          "SELECT 'non_day', l.household_id, l.intent_id, l.reserved_bytes, " +
          "i.expires_at, i.plaintext_bytes, i.chunk_count, i.consumed_at, " +
          "l.committed_at, b.committed_at, b.wire_bytes " +
          "FROM managed_non_day_staging_leases l " +
          "JOIN managed_non_day_upload_intents i " +
          "ON i.household_id=l.household_id AND i.id=l.intent_id " +
          "LEFT JOIN managed_non_day_committed_blobs b " +
          "ON b.household_id=l.household_id AND b.intent_id=l.intent_id " +
          "ORDER BY householdId,lineage,intentId LIMIT ?",
        ).all(MAX_LEASE_ROWS + 1);
        if (rows.length > MAX_LEASE_ROWS)
          throw new ExpiredLeaseReportUnavailable();
        const committedWireBytes = db.prepare<[], { bytes: number }>(
          "SELECT COALESCE(SUM(wire_bytes),0) AS bytes FROM (" +
          "SELECT wire_bytes FROM managed_committed_blobs UNION ALL " +
          "SELECT wire_bytes FROM managed_non_day_committed_blobs)",
        ).get()?.bytes;
        const logicalOccupancyBytes = db.prepare<[], { bytes: number }>(
          "SELECT COALESCE(SUM(bytes),0) AS bytes " +
          "FROM managed_wire_occupancy",
        ).get()?.bytes;
        if (!validBytes(committedWireBytes) ||
          !validBytes(logicalOccupancyBytes))
          throw new ExpiredLeaseReportUnavailable();
        const missingLeases = db.prepare<[], { n: number }>(
          "SELECT (SELECT count(*) FROM managed_committed_blobs b " +
          "LEFT JOIN managed_staging_leases l ON " +
          "l.household_id=b.household_id AND l.intent_id=b.intent_id " +
          "WHERE l.intent_id IS NULL) + " +
          "(SELECT count(*) FROM managed_non_day_committed_blobs b " +
          "LEFT JOIN managed_non_day_staging_leases l ON " +
          "l.household_id=b.household_id AND l.intent_id=b.intent_id " +
          "WHERE l.intent_id IS NULL) AS n",
        ).get()?.n;
        if (missingLeases !== 0)
          throw new ExpiredLeaseReportUnavailable();
        return { rows, committedWireBytes, logicalOccupancyBytes };
      }).deferred();
    const families = new Map<string, {
      expiredDayCount: number; expiredNonDayCount: number;
      expiredChargedBytes: number; otherUncommittedCount: number;
      otherUncommittedBytes: number }>();
    let uncommittedLeaseBytes = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!ID.test(row.householdId) || !ID.test(row.intentId) ||
        (row.lineage !== "day" && row.lineage !== "non_day") ||
        !validBytes(row.reservedBytes) || row.reservedBytes < 65 ||
        !validBytes(row.plaintextBytes) ||
        !Number.isSafeInteger(row.chunkCount) || row.chunkCount < 1 ||
        row.chunkCount > 100 ||
        row.chunkCount !== Math.max(1,
          Math.ceil(row.plaintextBytes / (1024 * 1024))) ||
        row.reservedBytes !== 33 + row.plaintextBytes +
          32 * row.chunkCount ||
        !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0)
        throw new ExpiredLeaseReportUnavailable();
      const identity = `${row.householdId}:${row.lineage}:${row.intentId}`;
      if (seen.has(identity)) throw new ExpiredLeaseReportUnavailable();
      seen.add(identity);
      const times = [row.consumedAt, row.leaseCommittedAt,
        row.blobCommittedAt];
      if (!times.every((value) => value === null) &&
        (!times.every((value) => Number.isSafeInteger(value) && value! > 0) ||
          times[0] !== times[1] || times[1] !== times[2]))
        throw new ExpiredLeaseReportUnavailable();
      if (row.leaseCommittedAt === null ? row.blobWireBytes !== null :
        row.blobWireBytes !== row.reservedBytes)
        throw new ExpiredLeaseReportUnavailable();
      if (row.leaseCommittedAt !== null) continue;
      uncommittedLeaseBytes += row.reservedBytes;
      if (!Number.isSafeInteger(uncommittedLeaseBytes))
        throw new ExpiredLeaseReportUnavailable();
      const summary = families.get(row.householdId) ?? {
        expiredDayCount: 0, expiredNonDayCount: 0,
        expiredChargedBytes: 0, otherUncommittedCount: 0,
        otherUncommittedBytes: 0 };
      if (row.expiresAt <= input.asOfUnixSeconds) {
        if (row.lineage === "day") summary.expiredDayCount += 1;
        else summary.expiredNonDayCount += 1;
        summary.expiredChargedBytes += row.reservedBytes;
      } else {
        summary.otherUncommittedCount += 1;
        summary.otherUncommittedBytes += row.reservedBytes;
      }
      families.set(row.householdId, summary);
    }
    if (committedWireBytes + uncommittedLeaseBytes !==
      logicalOccupancyBytes)
      throw new ExpiredLeaseReportUnavailable();
    const references = readCommittedCiphertextReferences(db);
    const objectInventory = await auditCiphertextObjectInventory({
      objectRoot: input.objectRoot, committedReferences: references });
    return Object.freeze({ asOfUnixSeconds: input.asOfUnixSeconds,
      diagnosticOnly: true as const, committedWireBytes,
      uncommittedLeaseBytes, logicalOccupancyBytes,
      families: Object.freeze(Array.from(families, ([householdId, values]) =>
        Object.freeze({ householdId, ...values }))
        .sort((a, b) => a.householdId.localeCompare(b.householdId))),
      objectInventory });
  } catch { throw new ExpiredLeaseReportUnavailable(); }
}

function validBytes(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
