import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export class UnsafeStorageDirectory extends Error {
  constructor() { super("Storage directory must be private and operator-controlled"); }
}

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new UnsafeStorageDirectory();
  }
}

/**
 * Create one child of an existing, private, durably provisioned parent; never
 * traverse arbitrary caller-supplied subpaths. The parent must itself live in
 * a trusted path. The child name is durable before the function returns.
 */
export async function provisionPrivateDirectory(parent: string, childName: string): Promise<string> {
  if (!isAbsolute(parent) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(childName))
    throw new UnsafeStorageDirectory();
  try {
    await privateDirectory(parent);
    const canonicalParent = await realpath(parent);
    await privateDirectory(canonicalParent);
    const child = join(canonicalParent, childName);
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) ||
        error.code !== "EEXIST") throw error;
    }
    await privateDirectory(child);
    // Even on EEXIST, another concurrent creator (or a previous failed call)
    // may not have synced the new name yet. Every success must sync the parent.
    const directory = await open(canonicalParent, "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
    return child;
  } catch {
    throw new UnsafeStorageDirectory();
  }
}
