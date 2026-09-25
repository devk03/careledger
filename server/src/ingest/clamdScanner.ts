import { dirname, isAbsolute } from "node:path";
import { createConnection, type Socket } from "node:net";
import { lstat } from "node:fs/promises";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { MalwareScanner } from "./inspection.js";

const CHUNK_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 4096;
const ENGINE = "clamd";

export type ClamdScannerOptions = Readonly<{
  socketPath: string;
  timeoutMs?: number;
  maxConcurrentScans?: number;
}>;

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

function parseReply(reply: Buffer): "clean" | "detected" | "unavailable" {
  // zINSTREAM requests have NUL-terminated replies. A scan error, a protocol
  // variant we do not recognize, or a truncated reply can never mean clean.
  const value = reply.toString("utf8");
  if (value === "stream: OK") return "clean";
  if (/^stream: [^\r\n\0]+ FOUND$/.test(value)) return "detected";
  return "unavailable";
}

async function trustedSocketPath(socketPath: string): Promise<boolean> {
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return false;
    const [parent, socket] = await Promise.all([lstat(dirname(socketPath)), lstat(socketPath)]);
    return parent.isDirectory() && socket.isSocket() &&
      (parent.mode & 0o022) === 0 &&
      (parent.uid === uid || parent.uid === 0) &&
      (socket.uid === uid || socket.uid === 0);
  } catch {
    return false;
  }
}

/**
 * Streams bounded bytes to a local clamd Unix socket. This adapter does not
 * start, configure, or update clamd; an unavailable daemon fails closed.
 * The full document bytes (which may contain text) are sent to the local
 * daemon. No separate filename, file path, or extracted-text field is sent.
 */
export function createClamdScanner(options: ClamdScannerOptions): MalwareScanner {
  if (!isAbsolute(options.socketPath)) throw new Error("CLAMD_SOCKET_MUST_BE_ABSOLUTE");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("INVALID_CLAMD_TIMEOUT");
  const maxConcurrentScans = options.maxConcurrentScans ?? 2;
  if (!Number.isSafeInteger(maxConcurrentScans) || maxConcurrentScans < 1 ||
    maxConcurrentScans > 8) throw new Error("INVALID_CLAMD_CONCURRENCY");
  let activeScans = 0;

  return {
    async scan(input) {
      if (input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES)
        return { verdict: "unavailable", engine: ENGINE };
      if (!await trustedSocketPath(options.socketPath))
        return { verdict: "unavailable", engine: ENGINE };
      if (activeScans >= maxConcurrentScans)
        return { verdict: "unavailable", engine: ENGINE };
      activeScans += 1;
      try {
        const bytes = Buffer.from(input);
        return await new Promise<Awaited<ReturnType<MalwareScanner["scan"]>>>((resolve) => {
          const socket = createConnection({ path: options.socketPath });
          let settled = false;
          let requestComplete = false;
          let reply = Buffer.alloc(0);
          const deadline = setTimeout(() => finish("unavailable"), timeoutMs);
          const finish = (verdict: "clean" | "detected" | "unavailable") => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve({ verdict, engine: ENGINE });
          };

          socket.on("error", () => finish("unavailable"));
          socket.on("end", () => finish("unavailable"));
          socket.on("data", (chunk: Buffer) => {
            // A success reply before the terminal zero-length frame has been
            // flushed cannot attest that the complete input was scanned.
            if (settled || !requestComplete || reply.length + chunk.length > MAX_REPLY_BYTES) {
              finish("unavailable");
              return;
            }
            reply = Buffer.concat([reply, chunk]);
            const terminator = reply.indexOf(0);
            if (terminator !== -1) {
              if (terminator !== reply.length - 1) finish("unavailable");
              else finish(parseReply(reply.subarray(0, terminator)));
            }
          });
          socket.once("connect", () => {
            void (async () => {
              await write(socket, Buffer.from("zINSTREAM\0", "ascii"));
              for (let offset = 0; offset < bytes.length && !settled; offset += CHUNK_BYTES) {
                const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
                const length = Buffer.alloc(4);
                length.writeUInt32BE(chunk.length);
                await write(socket, length);
                await write(socket, chunk);
              }
              if (!settled) {
                await write(socket, Buffer.alloc(4));
                requestComplete = true;
              }
            })().catch(() => finish("unavailable"));
          });
        });
      } finally {
        activeScans -= 1;
      }
    },
  };
}
