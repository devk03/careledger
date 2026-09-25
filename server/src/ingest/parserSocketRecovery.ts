import { randomUUID } from "node:crypto";
import { lstat, rename } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join } from "node:path";

export class ParserSocketRecoveryError extends Error {
  constructor() { super("PARSER_SOCKET_RECOVERY_FAILED"); }
}

type SocketState = "live" | "stale" | "absent" | "uncertain";

async function probeSocket(path: string): Promise<SocketState> {
  return new Promise((resolve) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (state: SocketState) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(state);
    };
    const deadline = setTimeout(() => finish("uncertain"), 500);
    socket.once("connect", () => finish("live"));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? "stale" :
        error.code === "ENOENT" ? "absent" : "uncertain");
    });
  });
}

/**
 * Only the dedicated worker calls this before bind. It never deletes a socket:
 * a verified, unresponsive inode is moved to a private archive name.
 */
export async function archiveStaleParserSocket(
  path: string, expectedName: "parser.sock" | "health.sock" = "parser.sock",
): Promise<
  { state: "absent" } | { state: "archived"; archivePath: string }
> {
  if (!isAbsolute(path) || basename(path) !== expectedName ||
    process.getuid === undefined || process.getuid() === 0)
    throw new ParserSocketRecoveryError();
  const parentPath = dirname(path);
  const parent = await lstat(parentPath);
  if (!parent.isDirectory() || parent.uid !== process.getuid() ||
    (parent.mode & 0o027) !== 0) throw new ParserSocketRecoveryError();
  let original: Awaited<ReturnType<typeof lstat>>;
  try { original = await lstat(path); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT") return { state: "absent" };
    throw new ParserSocketRecoveryError();
  }
  if (!original.isSocket() || original.uid !== process.getuid() ||
    (original.mode & 0o007) !== 0) throw new ParserSocketRecoveryError();
  const state = await probeSocket(path);
  if (state === "absent") return { state: "absent" };
  if (state !== "stale") throw new ParserSocketRecoveryError();
  let current: Awaited<ReturnType<typeof lstat>>;
  try { current = await lstat(path); }
  catch { throw new ParserSocketRecoveryError(); }
  if (!current.isSocket() || current.uid !== original.uid ||
    current.dev !== original.dev || current.ino !== original.ino ||
    current.mode !== original.mode) throw new ParserSocketRecoveryError();
  const archivePath = join(parentPath, `stale-${randomUUID()}.sock`);
  try { await lstat(archivePath); throw new ParserSocketRecoveryError(); }
  catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error &&
      error.code === "ENOENT")) throw error;
  }
  try { await rename(path, archivePath); }
  catch { throw new ParserSocketRecoveryError(); }
  return { state: "archived", archivePath };
}
