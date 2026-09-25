import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { StructuralInspector } from "./inspection.js";
import { createParserRequest, encodeParserRequestHeader, MAX_PARSER_REPLY_BYTES,
  parseParserReply } from "./parserProtocol.js";

const CHUNK_BYTES = 64 * 1024;
const rejected = Object.freeze({ status: "rejected" as const, pageCount: 0 });

export type ParserSocketOptions = Readonly<{
  socketPath: string;
  trustedWorkerUid: number;
  timeoutMs?: number;
  maxConcurrentInspections?: number;
}>;

async function trustedSocketPath(path: string, workerUid: number): Promise<boolean> {
  try {
    const appUid = process.getuid?.();
    if (appUid === undefined) return false;
    const [parent, socket] = await Promise.all([lstat(dirname(path)), lstat(path)]);
    const trustedOwner = (uid: number) => uid === 0 || uid === appUid || uid === workerUid;
    return parent.isDirectory() && socket.isSocket() &&
      (parent.mode & 0o022) === 0 && trustedOwner(parent.uid) &&
      trustedOwner(socket.uid);
  } catch {
    return false;
  }
}

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

/**
 * Transport adapter, not a parser or sandbox. The configured trusted worker
 * must independently hash and inspect all bytes inside an OS-enforced sandbox.
 */
export function createParserSocketInspector(options: ParserSocketOptions): StructuralInspector {
  if (!isAbsolute(options.socketPath)) throw new Error("PARSER_SOCKET_MUST_BE_ABSOLUTE");
  if (!Number.isSafeInteger(options.trustedWorkerUid) || options.trustedWorkerUid < 0)
    throw new Error("INVALID_PARSER_WORKER_UID");
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxConcurrentInspections = options.maxConcurrentInspections ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxConcurrentInspections) || maxConcurrentInspections < 1 ||
    maxConcurrentInspections > 8) throw new Error("INVALID_PARSER_LIMIT");
  let active = 0;

  return {
    async inspect(input, mediaType) {
      if (input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES ||
        !await trustedSocketPath(options.socketPath, options.trustedWorkerUid) ||
        active >= maxConcurrentInspections) return rejected;
      active += 1;
      try {
        const bytes = Buffer.from(input);
        const request = createParserRequest({ mediaType, byteSize: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
        const header = encodeParserRequestHeader(request);
        return await new Promise<Awaited<ReturnType<StructuralInspector["inspect"]>>>((resolve) => {
          const socket = createConnection({ path: options.socketPath });
          let settled = false;
          let requestComplete = false;
          let reply = Buffer.alloc(0);
          const deadline = setTimeout(() => finish(rejected), timeoutMs);
          const finish = (result: Awaited<ReturnType<StructuralInspector["inspect"]>>) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            socket.destroy();
            resolve(result);
          };

          socket.on("error", () => finish(rejected));
          socket.on("close", () => finish(rejected));
          socket.on("data", (chunk: Buffer) => {
            if (!requestComplete || reply.length + chunk.length > 4 + MAX_PARSER_REPLY_BYTES) {
              finish(rejected);
              return;
            }
            reply = Buffer.concat([reply, chunk]);
            if (reply.length >= 4) {
              const length = reply.readUInt32BE(0);
              if (length < 2 || length > MAX_PARSER_REPLY_BYTES || reply.length > 4 + length)
                finish(rejected);
            }
          });
          socket.on("end", () => {
            if (!requestComplete || reply.length < 4) return finish(rejected);
            const length = reply.readUInt32BE(0);
            if (length < 2 || length > MAX_PARSER_REPLY_BYTES || reply.length !== 4 + length)
              return finish(rejected);
            try {
              const parsed = parseParserReply(reply.subarray(4), request);
              finish(parsed.verdict === "safe"
                ? { status: "safe", pageCount: parsed.pageCount } : rejected);
            } catch {
              finish(rejected);
            }
          });
          socket.once("connect", () => {
            void (async () => {
              await write(socket, header);
              for (let offset = 0; offset < bytes.length && !settled; offset += CHUNK_BYTES)
                await write(socket, bytes.subarray(offset, offset + CHUNK_BYTES));
              if (!settled) requestComplete = true;
            })().catch(() => finish(rejected));
          });
        });
      } catch {
        return rejected;
      } finally {
        active -= 1;
      }
    },
  };
}
