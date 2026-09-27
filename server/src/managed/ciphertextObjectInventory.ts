import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { readCiphertextChunk } from "./ciphertextObjectStore.js";
import type { CiphertextObjectReference } from "./ciphertextObjectSnapshot.js";

const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const PREFIX = /^[0-9a-f]{2}$/u;
const PENDING = /^pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX_ENTRIES = 1_000_000;
const MAX_OBJECT_BYTES = 1024 * 1024 + 16;

export class CiphertextObjectInventoryError extends Error {
  constructor() { super("Private ciphertext object inventory is unavailable"); }
}

export type CiphertextObjectInventory = Readonly<{
  committedObjectCount: number;
  committedBytes: number;
  missingCommitted: readonly CiphertextObjectReference[];
  corruptCommitted: readonly CiphertextObjectReference[];
  uniqueInodeContentBytes: number;
  unreferencedInodeContentBytes: number;
  orphanInodes: number;
  orphanFinalNames: number;
  orphanPendingNames: number;
  committedPendingAliases: number;
}>;

type FileEntry = { path: string; householdHash: string; name: string;
  size: number; inode: string; linkCount: bigint };

/**
 * Read-only, offline inventory. The caller must quiesce writers and supply
 * references from one consistent committed DB snapshot. It never releases a
 * lease, deletes an object, or treats an orphan as safely reclaimable.
 * Byte totals sum file lengths once per inode; they are not allocated disk
 * blocks and cannot enforce a physical-volume quota.
 */
export async function auditCiphertextObjectInventory(input: {
  objectRoot: string;
  committedReferences: readonly CiphertextObjectReference[];
}): Promise<CiphertextObjectInventory> {
  try { return await scanCiphertextObjectInventory(input); }
  catch { throw new CiphertextObjectInventoryError(); }
}

async function scanCiphertextObjectInventory(input: {
  objectRoot: string;
  committedReferences: readonly CiphertextObjectReference[];
}): Promise<CiphertextObjectInventory> {
  const root = await privateDirectory(input.objectRoot);
  const references = validateReferences(input.committedReferences);
  const expectedByPath = new Map<string, CiphertextObjectReference>();
  for (const reference of references) {
    const hash = createHash("sha256").update(reference.householdId).digest("hex");
    const path = join(root, hash.slice(0, 2), hash.slice(2, 4), hash,
      reference.storageObjectId);
    if (expectedByPath.has(path)) throw new CiphertextObjectInventoryError();
    expectedByPath.set(path, reference);
  }

  const byInode = new Map<string, FileEntry[]>();
  let entries = 0;
  let uniqueInodeContentBytes = 0;
  for (const first of await readdir(root)) {
    if (!PREFIX.test(first)) throw new CiphertextObjectInventoryError();
    const firstPath = await privateDirectory(join(root, first));
    for (const second of await readdir(firstPath)) {
      if (!PREFIX.test(second)) throw new CiphertextObjectInventoryError();
      const secondPath = await privateDirectory(join(firstPath, second));
      for (const householdHash of await readdir(secondPath)) {
        if (!HASH.test(householdHash) || householdHash.slice(0, 4) !== first + second)
          throw new CiphertextObjectInventoryError();
        const householdPath = await privateDirectory(join(secondPath, householdHash));
        for (const name of await readdir(householdPath)) {
          if (!ID.test(name) && !PENDING.test(name))
            throw new CiphertextObjectInventoryError();
          if (++entries > MAX_ENTRIES) throw new CiphertextObjectInventoryError();
          const path = join(householdPath, name);
          const info = await lstat(path, { bigint: true });
          const mode = info.mode & 0o777n;
          if (!info.isFile() || info.isSymbolicLink() ||
            (process.getuid !== undefined && info.uid !== BigInt(process.getuid())) ||
            info.size < 0n || info.size > BigInt(MAX_OBJECT_BYTES) ||
            (ID.test(name) ? mode !== 0o400n : mode !== 0o400n && mode !== 0o600n))
            throw new CiphertextObjectInventoryError();
          const inode = `${info.dev}:${info.ino}`;
          const group = byInode.get(inode);
          const size = Number(info.size);
          const file = { path, householdHash, name, size, inode,
            linkCount: info.nlink };
          if (group) {
            if (group[0]!.size !== size ||
              group[0]!.householdHash !== householdHash ||
              group[0]!.linkCount !== info.nlink)
              throw new CiphertextObjectInventoryError();
            group.push(file);
          } else {
            byInode.set(inode, [file]);
            uniqueInodeContentBytes += size;
          }
        }
      }
    }
  }

  const missingCommitted: CiphertextObjectReference[] = [];
  const corruptCommitted: CiphertextObjectReference[] = [];
  for (const [path, reference] of expectedByPath) {
    try {
      await lstat(path);
    } catch (error) {
      if (isMissing(error)) { missingCommitted.push(reference); continue; }
      throw new CiphertextObjectInventoryError();
    }
    try {
      await readCiphertextChunk(root, reference.householdId,
        reference.storageObjectId, reference.sha256, reference.byteSize);
    } catch { corruptCommitted.push(reference); }
  }

  let unreferencedInodeContentBytes = 0;
  let orphanInodes = 0;
  let orphanFinalNames = 0;
  let orphanPendingNames = 0;
  let committedPendingAliases = 0;
  for (const group of byInode.values()) {
    if (BigInt(group.length) !== group[0]!.linkCount)
      throw new CiphertextObjectInventoryError();
    const finals = group.filter((entry) => ID.test(entry.name));
    if (finals.length > 1) throw new CiphertextObjectInventoryError();
    const committed = finals.some((entry) => expectedByPath.has(entry.path));
    const pendingCount = group.length - finals.length;
    if (committed) committedPendingAliases += pendingCount;
    else {
      orphanInodes += 1;
      unreferencedInodeContentBytes += group[0]!.size;
      orphanFinalNames += finals.length;
      orphanPendingNames += pendingCount;
    }
  }
  return Object.freeze({ committedObjectCount: references.length,
    committedBytes: references.reduce((sum, row) => sum + row.byteSize, 0),
    missingCommitted, corruptCommitted, uniqueInodeContentBytes,
    unreferencedInodeContentBytes,
    orphanInodes, orphanFinalNames, orphanPendingNames, committedPendingAliases });
}

function validateReferences(input: readonly CiphertextObjectReference[]):
  CiphertextObjectReference[] {
  if (!Array.isArray(input) || input.length > MAX_ENTRIES)
    throw new CiphertextObjectInventoryError();
  const result: CiphertextObjectReference[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) throw new CiphertextObjectInventoryError();
    const row = input[index];
    if (!row || !ID.test(row.householdId) || !ID.test(row.storageObjectId) ||
      !HASH.test(row.sha256) || !Number.isSafeInteger(row.byteSize) ||
      row.byteSize < 16 || row.byteSize > MAX_OBJECT_BYTES)
      throw new CiphertextObjectInventoryError();
    const key = `${row.householdId}:${row.storageObjectId}`;
    if (seen.has(key)) throw new CiphertextObjectInventoryError();
    seen.add(key);
    result.push(row);
  }
  return result;
}

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CiphertextObjectInventoryError();
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new CiphertextObjectInventoryError();
    return await realpath(path);
  } catch { throw new CiphertextObjectInventoryError(); }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}
