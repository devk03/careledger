import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, open, realpath } from "node:fs/promises";
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
  let alreadyExisted = false;
  try {
    // A hard link is atomic and cannot replace an existing digest path. The
    // quarantine and object roots must reside on the same private filesystem.
    await link(expectedStagePath, destination);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) ||
      error.code !== "EEXIST") throw new ObjectIntegrityError();
    alreadyExisted = true;
  }
  await verifyStored(destination, staged);
  // A prior crash may have linked an object before making it read-only. On a
  // verified retry, finish that metadata transition as well.
  await chmod(destination, 0o400); // Both hard links now refer to read-only bytes.
  const file = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); }
  finally { await file.close(); }
  const directory = await open(second, "r");
  try { await directory.sync(); }
  finally { await directory.close(); }
  await verifyStored(destination, staged);
  return { sha256: staged.sha256, byteSize: staged.byteSize,
    path: destination, alreadyExisted };
}
