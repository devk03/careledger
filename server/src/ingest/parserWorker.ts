import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";

import { decodeImageInWorker } from "./imageDecoder.js";
import { MAX_PARSER_HEADER_BYTES, MAX_PARSER_REPLY_BYTES, PARSER_WORKER_VERSION,
  parseParserRequestHeader, type ParserRequest } from "./parserProtocol.js";

const MAX_CONNECTIONS = 4;

export type ParserWorkerOptions = Readonly<{
  socketPath: string;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
}>;

async function assertPrivateSocketParent(path: string): Promise<void> {
  if (!isAbsolute(path) || process.getuid === undefined) throw new Error("UNSAFE_PARSER_SOCKET");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid() ||
    (parent.mode & 0o027) !== 0) throw new Error("UNSAFE_PARSER_SOCKET");
}

function replyFrame(value: object): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MAX_PARSER_REPLY_BYTES) throw new Error("PARSER_REPLY_TOO_LARGE");
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

/**
 * Worker-side protocol handler. Container/cgroup/network isolation is a
 * separate deployment gate; do not run this in the Express process.
 */
export async function startParserWorkerServer(options: ParserWorkerOptions): Promise<Server> {
  await assertPrivateSocketParent(options.socketPath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 ||
    maxConcurrentRequests > MAX_CONNECTIONS) throw new Error("INVALID_PARSER_WORKER_LIMIT");
  let active = 0;

  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    if (active >= maxConcurrentRequests) {
      socket.destroy();
      return;
    }
    active += 1;
    const header = Buffer.alloc(4 + MAX_PARSER_HEADER_BYTES);
    let headerUsed = 0;
    let headerLength: number | null = null;
    let request: ParserRequest | null = null;
    let payload: Buffer | null = null;
    let payloadUsed = 0;
    let invalid = false;
    let processing = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    const deadline = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on("close", () => {
      clearTimeout(deadline);
      if (!processing) release();
    });
    socket.on("error", () => socket.destroy());

    socket.on("data", (chunk: Buffer) => {
      if (invalid) return;
      let cursor = 0;
      try {
        while (cursor < chunk.length) {
          if (request === null) {
            const wanted = headerLength === null ? 4 : 4 + headerLength;
            const amount = Math.min(wanted - headerUsed, chunk.length - cursor);
            chunk.copy(header, headerUsed, cursor, cursor + amount);
            headerUsed += amount;
            cursor += amount;
            if (headerUsed === 4 && headerLength === null) {
              headerLength = header.readUInt32BE(0);
              if (headerLength < 2 || headerLength > MAX_PARSER_HEADER_BYTES)
                throw new Error("BAD_PARSER_HEADER_LENGTH");
            }
            if (headerLength !== null && headerUsed === 4 + headerLength) {
              request = parseParserRequestHeader(header.subarray(4, headerUsed));
              payload = Buffer.allocUnsafe(request.byteSize);
            }
          } else {
            const remaining = request.byteSize - payloadUsed;
            if (remaining === 0 || payload === null) throw new Error("EXCESS_PARSER_BYTES");
            const amount = Math.min(remaining, chunk.length - cursor);
            chunk.copy(payload, payloadUsed, cursor, cursor + amount);
            payloadUsed += amount;
            cursor += amount;
          }
        }
      } catch {
        invalid = true;
        socket.destroy();
      }
    });

    socket.on("end", () => {
      if (invalid || request === null || payload === null || payloadUsed !== request.byteSize) {
        socket.destroy();
        return;
      }
      const received = createHash("sha256").update(payload).digest("hex");
      const boundRequest = request;
      const boundPayload = payload;
      processing = true;
      void (async () => {
        let outcome: object;
        if (received !== boundRequest.sha256) {
          outcome = { verdict: "rejected", code: "MALFORMED" };
        } else if (boundRequest.mediaType === "application/pdf") {
          outcome = { verdict: "rejected", code: "UNSUPPORTED" };
        } else {
          outcome = await decodeImageInWorker(boundPayload, boundRequest.mediaType);
        }
        if (!socket.destroyed) socket.end(replyFrame({ ...boundRequest,
          workerVersion: PARSER_WORKER_VERSION, ...outcome }));
      })().catch(() => socket.destroy()).finally(() => {
        processing = false;
        if (socket.destroyed) release();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
