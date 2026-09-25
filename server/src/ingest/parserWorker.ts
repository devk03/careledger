import { createHash } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import type { ImageDecodeResult, ImageMediaType } from "./imageDecoder.js";
import { decodeImageInSubprocess } from "./imageDecodeProcess.js";
import { MAX_PARSER_HEADER_BYTES, MAX_PARSER_REPLY_BYTES, PARSER_WORKER_VERSION,
  parseParserRequestHeader, type ParserRequest } from "./parserProtocol.js";

const MAX_CONNECTIONS = 4;

export type ParserWorkerOptions = Readonly<{
  socketPath: string;
  timeoutMs?: number;
  maxConcurrentRequests?: number;
}>;

/** Dependency overrides are for synthetic tests; production uses both defaults. */
export type ParserWorkerDependencies = Readonly<{
  decodeImage?: (bytes: Uint8Array, mediaType: ImageMediaType,
    signal: AbortSignal) => Promise<ImageDecodeResult>;
  childScriptPath?: string;
  terminateProcess?: (exitCode: number) => never;
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
export async function startParserWorkerServer(
  options: ParserWorkerOptions, dependencies: ParserWorkerDependencies = {},
): Promise<Server> {
  await assertPrivateSocketParent(options.socketPath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 ||
    maxConcurrentRequests > MAX_CONNECTIONS) throw new Error("INVALID_PARSER_WORKER_LIMIT");
  const childScriptPath = dependencies.childScriptPath ??
    fileURLToPath(new URL("./imageDecodeChild.js", import.meta.url));
  const decodeImage = dependencies.decodeImage ?? ((bytes: Uint8Array,
    mediaType: ImageMediaType, signal: AbortSignal) =>
    decodeImageInSubprocess(bytes, mediaType, { scriptPath: childScriptPath,
      timeoutMs, signal }));
  const terminateProcess = dependencies.terminateProcess ??
    ((exitCode: number): never => process.exit(exitCode));
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
    const decodeAbort = new AbortController();
    let terminating = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    const fatal = (exitCode: number) => {
      if (terminating) return;
      terminating = true;
      decodeAbort.abort();
      socket.destroy();
      // A native decoder is not reliably cancellable in-process. This worker
      // must run as its own container process so a hard exit ends the job.
      terminateProcess(exitCode);
    };
    const deadline = setTimeout(() => {
      if (processing) fatal(124);
      else socket.destroy();
    }, timeoutMs);
    socket.on("close", () => {
      clearTimeout(deadline);
      if (processing) fatal(125);
      else release();
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
          outcome = await decodeImage(boundPayload, boundRequest.mediaType, decodeAbort.signal);
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
  try {
    await chmod(options.socketPath, 0o660);
    const socket = await lstat(options.socketPath);
    if (!socket.isSocket() || socket.uid !== process.getuid!() ||
      (socket.mode & 0o777) !== 0o660) throw new Error("UNSAFE_PARSER_SOCKET");
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
  return server;
}
