import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import { provisionPrivateDirectory } from "./privateDirectory.js";
import type { StagedOriginal } from "./staging.js";

const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class ObjectIntegrityError extends Error {
  constructor() { super("Staged or stored object failed integrity verification"); }
}

export type StoredOriginal = {
  sha256: string;
  byteSize: number;
  path: string;
  alreadyExisted: boolean;
};

export type PendingObject = {
  pendingId: string;
  byteSize: number;
  sha256: string | null;
  state: "linked_alias" | "duplicate_copy" | "unpublished" | "conflict" | "unsafe";
};

async function assertPrivateRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new ObjectIntegrityError();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())) throw new ObjectIntegrityError();
  const canonical = await realpath(path);
  const actual = await lstat(canonical);
  if (!actual.isDirectory() || (actual.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && actual.uid !== process.getuid())) throw new ObjectIntegrityError();
  return canonical;
}

async function hashPrivateFile(path: string, expectedSize: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== expectedSize || (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid())) throw new ObjectIntegrityError();
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < info.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, info.size - position), position);
      if (bytesRead === 0) throw new ObjectIntegrityError();
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== info.size || after.ino !== info.ino || after.dev !== info.dev)
      throw new ObjectIntegrityError();
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function verifyStored(path: string, staged: StagedOriginal): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() ||
    await hashPrivateFile(path, staged.byteSize) !== staged.sha256) throw new ObjectIntegrityError();
}

/**
 * Filesystem primitive only. A future intake coordinator must run malware and
 * structural checks before calling this; publication here does not authorize
 * a document row, day placement, download, or preview. Failed publications
 * leave private orphans for explicit reconciliation, never silent deletion.
 */
export async function commitStagedObject(
  objectRoot: string,
  quarantineRoot: string,
  staged: StagedOriginal,
): Promise<StoredOriginal> {
  if (!SHA256.test(staged.sha256) || !UUID.test(staged.stageId) ||
    !Number.isSafeInteger(staged.byteSize) || staged.byteSize < 1 ||
    staged.byteSize > MAX_UPLOAD_BYTES || !isAbsolute(staged.path)) throw new ObjectIntegrityError();

  const quarantine = await assertPrivateRoot(quarantineRoot);
  const objects = await assertPrivateRoot(objectRoot);
  const expectedStagePath = join(quarantine, `incoming-${staged.stageId}`);
  if (dirname(staged.path) !== quarantine || basename(staged.path) !== basename(expectedStagePath) ||
    staged.path !== expectedStagePath) throw new ObjectIntegrityError();
  const stagedInfo = await lstat(expectedStagePath);
  if (!stagedInfo.isFile() || stagedInfo.isSymbolicLink() ||
    await hashPrivateFile(expectedStagePath, staged.byteSize) !== staged.sha256)
    throw new ObjectIntegrityError();

  const first = await provisionPrivateDirectory(objects, staged.sha256.slice(0, 2));
  const second = await provisionPrivateDirectory(first, staged.sha256.slice(2, 4));
  const destination = join(second, staged.sha256);
  // Most duplicates can return without copying. A concurrent publisher is
  // still handled by the no-clobber link below.
  try {
    await lstat(destination);
    await verifyStored(destination, staged);
    await chmod(destination, 0o400);
    const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await existing.sync(); }
    finally { await existing.close(); }
    const directory = await open(second, "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
    return { sha256: staged.sha256, byteSize: staged.byteSize,
      path: destination, alreadyExisted: true };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) ||
      error.code !== "ENOENT") throw error;
  }

  const pendingPath = join(second, `pending-${randomUUID()}`);
  let alreadyExisted = false;
  let output: Awaited<ReturnType<typeof open>>;
  try {
    // The incomplete name is never a digest path or a document reference.
    // Successful publication keeps a read-only hard-link alias, not a second
    // copy of the bytes. Failed pending inodes remain for reconciliation.
    output = await open(pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new ObjectIntegrityError();
  }
  let source: Awaited<ReturnType<typeof open>> | null = null;
  try {
    source = await open(expectedStagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    const copiedHash = createHash("sha256");
    let position = 0;
    while (position < staged.byteSize) {
      const { bytesRead } = await source.read(chunk, 0,
        Math.min(chunk.length, staged.byteSize - position), position);
      if (bytesRead === 0) throw new ObjectIntegrityError();
      copiedHash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) throw new ObjectIntegrityError();
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    if (copiedHash.digest("hex") !== staged.sha256) throw new ObjectIntegrityError();
    await output.sync();
    await output.chmod(0o400);
    await output.sync();
  } finally {
    try { await source?.close(); }
    finally { await output.close(); }
  }
  await verifyStored(pendingPath, staged);
  try {
    await link(pendingPath, destination);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) ||
      error.code !== "EEXIST") throw new ObjectIntegrityError();
    alreadyExisted = true;
    await verifyStored(destination, staged);
  }
  const directory = await open(second, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
  await verifyStored(destination, staged);
  return { sha256: staged.sha256, byteSize: staged.byteSize,
    path: destination, alreadyExisted };
}

/**
 * Read-only inventory for backup/reconciliation. It never deletes a pending
 * alias, copies clinical bytes into output, or treats an orphan as published.
 */
export async function inventoryPendingObjects(objectRoot: string): Promise<PendingObject[]> {
  const root = await assertPrivateRoot(objectRoot);
  const result: PendingObject[] = [];
  for (const first of await readdir(root, { withFileTypes: true })) {
    if (!/^[0-9a-f]{2}$/.test(first.name) || !first.isDirectory())
      throw new ObjectIntegrityError();
    const firstPath = join(root, first.name);
    await assertPrivateRoot(firstPath);
    for (const second of await readdir(firstPath, { withFileTypes: true })) {
      if (!/^[0-9a-f]{2}$/.test(second.name) || !second.isDirectory())
        throw new ObjectIntegrityError();
      const secondPath = join(firstPath, second.name);
      await assertPrivateRoot(secondPath);
      for (const entry of await readdir(secondPath, { withFileTypes: true })) {
        if (SHA256.test(entry.name)) continue;
        if (!/^pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name))
          throw new ObjectIntegrityError();
        if (result.length >= 10_000) throw new ObjectIntegrityError();
        const path = join(secondPath, entry.name);
        const info = await lstat(path);
        const pendingId = entry.name.slice("pending-".length);
        if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
          (process.getuid !== undefined && info.uid !== process.getuid()) ||
          info.size < 1 || info.size > MAX_UPLOAD_BYTES) {
          result.push({ pendingId, byteSize: info.size, sha256: null, state: "unsafe" });
          continue;
        }
        let digest: string;
        try { digest = await hashPrivateFile(path, info.size); }
        catch {
          result.push({ pendingId, byteSize: info.size, sha256: null, state: "unsafe" });
          continue;
        }
        const destination = join(secondPath, digest);
        let state: PendingObject["state"];
        try {
          const published = await lstat(destination);
          if (!published.isFile() || published.isSymbolicLink() ||
            await hashPrivateFile(destination, info.size) !== digest) {
            state = "conflict";
          } else {
            state = published.dev === info.dev && published.ino === info.ino
              ? "linked_alias" : "duplicate_copy";
          }
        } catch (error) {
          state = typeof error === "object" && error !== null && "code" in error &&
            error.code === "ENOENT" ? "unpublished" : "conflict";
        }
        result.push({ pendingId, byteSize: info.size, sha256: digest, state });
      }
    }
  }
  return result.sort((a, b) => a.pendingId.localeCompare(b.pendingId));
}
