import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { MAX_UPLOAD_BYTES } from "./admission.js";
import type { ImageMediaType } from "./imageDecoder.js";
import { MAX_RENDITION_REPLY_BYTES, type ImageRenditionResult } from "./imageRenditionProtocol.js";
import { createParserRequest, encodeParserRequestHeader, parseParserRenditionReply } from "./parserProtocol.js";
import { trustedParserSocketPath, type ParserSocketOptions } from "./parserSocket.js";

const rejected = Object.freeze({ verdict: "rejected" as const, code: "MALFORMED" as const });
/** Transport only. All native rendering stays inside the isolated parser worker. */
export function createParserSocketRenderer(options: ParserSocketOptions) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxConcurrent = options.maxConcurrentInspections ?? 1;
  if (!isAbsolute(options.socketPath) || !Number.isSafeInteger(options.trustedWorkerUid) || options.trustedWorkerUid < 0 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 ||
    !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new Error("INVALID_PARSER_LIMIT");
  let active = 0;
  return async (input: Uint8Array, mediaType: ImageMediaType): Promise<ImageRenditionResult> => {
    if (input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES || !["image/png", "image/jpeg"].includes(mediaType) || active >= maxConcurrent) return rejected;
    const bytes = Buffer.from(input); active++;
    try {
      if (!await trustedParserSocketPath(options.socketPath, options.trustedWorkerUid)) return rejected;
      const request = createParserRequest({ mediaType, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), purpose: "rendition" });
      const header = encodeParserRequestHeader(request);
      return await new Promise(resolve => {
        const socket = createConnection({ path: options.socketPath });
        const chunks: Buffer[] = []; let total = 0; let settled = false; let sent = false;
        let frameLength: number | null = null;
        const finish = (value: ImageRenditionResult) => {
          if (settled) return;
          settled = true; clearTimeout(deadline); socket.destroy(); resolve(value);
        };
        const deadline = setTimeout(() => finish(rejected), timeoutMs);
        socket.on("error", () => finish(rejected)); socket.on("close", () => finish(rejected));
        socket.on("data", (chunk: Buffer) => {
          if (!sent || total + chunk.length > MAX_RENDITION_REPLY_BYTES + 4) return finish(rejected);
          total += chunk.length; chunks.push(chunk);
          if (frameLength === null && total >= 4) {
            frameLength = Buffer.concat(chunks, total).readUInt32BE(0);
            if (frameLength < 2 || frameLength > MAX_RENDITION_REPLY_BYTES) return finish(rejected);
          }
          if (frameLength !== null && total > frameLength + 4) finish(rejected);
        });
        socket.on("end", () => {
          if (!sent || frameLength === null || total !== frameLength + 4) return finish(rejected);
          try { finish(parseParserRenditionReply(Buffer.concat(chunks, total).subarray(4), request)); }
          catch { finish(rejected); }
        });
        socket.once("connect", () => {
          void (async () => {
            const write = (data: Buffer) => new Promise<void>((done, fail) => socket.write(data, error => error ? fail(error) : done()));
            await write(header);
            for (let offset = 0; offset < bytes.length && !settled; offset += 64 * 1024) await write(bytes.subarray(offset, offset + 64 * 1024));
            if (!settled) { sent = true; socket.end(); }
          })().catch(() => finish(rejected));
        });
      });
    } catch { return rejected; }
    finally { active--; }
  };
}
