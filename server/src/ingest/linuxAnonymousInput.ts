import { constants } from "node:fs";
import { open, statfs } from "node:fs/promises";

import { MAX_UPLOAD_BYTES } from "./admission.js";

// Linux __O_TMPFILE is not exposed by Node 22. O_DIRECTORY is supplied by
// Node because its numeric value varies by architecture. This adapter is
// intentionally Linux x64/arm64-only and fails rather than naming a file.
const LINUX_UNNAMED_FILE_FLAG = 0o20000000;
const TMPFS_MAGIC = 0x01021994;
const DIRECTORY = "/tmp";

export class AnonymousInputUnavailable extends Error {
  constructor() { super("ANONYMOUS_INPUT_UNAVAILABLE"); }
}

/**
 * Synthetic-only seekable input experiment. The inherited descriptor is
 * read-only, but the same-UID child can reopen the inode for writing through
 * procfs. It is NOT an immutable exact-byte boundary and must not be used to
 * produce a PDF safety verdict or process real records. No upload route calls it.
 */
export async function withLinuxAnonymousSeekableInput<T>(
  input: Uint8Array, useReadOnlyFd: (fd: number) => Promise<T>,
): Promise<T> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) ||
    process.getuid === undefined || process.getuid() === 0 ||
    input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES ||
    constants.O_DIRECTORY === undefined)
    throw new AnonymousInputUnavailable();
  const snapshot = Buffer.from(input);
  if (snapshot.byteLength !== input.byteLength) throw new AnonymousInputUnavailable();
  try {
    const filesystem = await statfs(DIRECTORY);
    if (filesystem.type !== TMPFS_MAGIC) throw new AnonymousInputUnavailable();
  } catch { throw new AnonymousInputUnavailable(); }

  let writer;
  try {
    writer = await open(DIRECTORY, LINUX_UNNAMED_FILE_FLAG | constants.O_DIRECTORY |
      constants.O_RDWR | constants.O_EXCL, 0o600);
  } catch { throw new AnonymousInputUnavailable(); }
  let writerClosed = false;
  let reader: Awaited<ReturnType<typeof open>> | undefined;
  try {
    for (let offset = 0; offset < snapshot.byteLength;) {
      const { bytesWritten } = await writer.write(snapshot, offset,
        snapshot.byteLength - offset, offset);
      if (bytesWritten < 1) throw new AnonymousInputUnavailable();
      offset += bytesWritten;
    }
    const written = await writer.stat();
    if (!written.isFile() || written.size !== snapshot.byteLength ||
      written.uid !== process.getuid() || (written.mode & 0o777) !== 0o600)
      throw new AnonymousInputUnavailable();
    reader = await open(`/proc/self/fd/${writer.fd}`, constants.O_RDONLY);
    const readable = await reader.stat();
    if (!readable.isFile() || readable.dev !== written.dev ||
      readable.ino !== written.ino || readable.size !== snapshot.byteLength)
      throw new AnonymousInputUnavailable();
    await writer.close();
    writerClosed = true;
    return await useReadOnlyFd(reader.fd);
  } finally {
    try { await reader?.close(); }
    finally { if (!writerClosed) await writer.close(); }
  }
}
