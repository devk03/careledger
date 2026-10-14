import { lstat, opendir, realpath, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { MAX_UPLOAD_BYTES } from "./admission.js";

/** Counts private stages, objects and orphans; hard-link aliases count once. */
export function createPrivateIntakeCapacity(input: {
  roots: readonly string[]; maxBytes: number; minimumFreeBytes?: number;
}) {
  const roots = [...input.roots];
  const maxBytes = input.maxBytes;
  const minimumFreeBytes = input.minimumFreeBytes ?? 64 * 1024 * 1024;
  if (!roots.length || roots.some(root => !isAbsolute(root)) ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
    !Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0)
    throw new Error("Invalid private storage capacity configuration");
  return async (additionalBytes: number): Promise<boolean> => {
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 1 ||
      additionalBytes > MAX_UPLOAD_BYTES * 2 || additionalBytes > maxBytes) return false;
    const seen = new Set<string>();
    let entries = 0;
    let used = 0;
    const visit = async (path: string, depth: number): Promise<boolean> => {
      if (++entries > 50_000 || depth > 8) return false;
      const info = await lstat(path);
      if (info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
        (process.getuid !== undefined && info.uid !== process.getuid())) return false;
      const identity = `${info.dev}:${info.ino}`;
      if (seen.has(identity)) return true;
      seen.add(identity);
      used += Math.max(info.size, info.blocks * 512);
      if (!Number.isSafeInteger(used) || used + additionalBytes > maxBytes) return false;
      if (info.isFile()) return true;
      if (!info.isDirectory()) return false;
      for await (const entry of await opendir(path)) {
        if (!await visit(join(path, entry.name), depth + 1)) return false;
      }
      return true;
    };
    try {
      for (const root of roots) {
        if (!(await lstat(root)).isDirectory() || !await visit(await realpath(root), 0)) return false;
        const filesystem = await statfs(root);
        const free = filesystem.bavail * filesystem.bsize;
        if (!Number.isSafeInteger(free) || free < minimumFreeBytes + additionalBytes) return false;
      }
      return true;
    } catch { return false; }
  };
}
