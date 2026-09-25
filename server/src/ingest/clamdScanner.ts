import { isAbsolute } from "node:path";
import { createConnection, type Socket } from "node:net";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { MalwareScanner } from "./inspection.js";

const CHUNK_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 4096;
const ENGINE = "clamd";

export type ClamdScannerOptions = Readonly<{
  socketPath: string;
  timeoutMs?: number;
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

/**
 * Streams bounded bytes to a local clamd Unix socket. This adapter does not
 * start, configure, or update clamd; an unavailable daemon fails closed.
 * No file path, filename, or document text is sent in the protocol.
 */
export function createClamdScanner(options: ClamdScannerOptions): MalwareScanner {
  if (!isAbsolute(options.socketPath)) throw new Error("CLAMD_SOCKET_MUST_BE_ABSOLUTE");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("INVALID_CLAMD_TIMEOUT");

  return {
    async scan(input) {
      if (input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES)
        return { verdict: "unavailable", engine: ENGINE };
      const bytes = Buffer.from(input);
      return new Promise((resolve) => {
        const socket = createConnection({ path: options.socketPath });
        let settled = false;
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
          if (settled || reply.length + chunk.length > MAX_REPLY_BYTES) {
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
            if (!settled) await write(socket, Buffer.alloc(4));
          })().catch(() => finish("unavailable"));
        });
      });
    },
  };
}
