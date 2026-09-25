import { createConnection, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { createParserRequest, encodeParserRequestHeader,
  parseParserReply } from "../src/ingest/parserProtocol.js";
import { createParserSocketInspector } from "../src/ingest/parserSocket.js";
import { startParserWorkerServer } from "../src/ingest/parserWorker.js";

async function worker() {
  const directory = await mkdtemp(join(tmpdir(), "adeno-fictional-real-worker-"));
  const socketPath = join(directory, "parser.sock");
  const server = await startParserWorkerServer({ socketPath, timeoutMs: 1000 });
  return { socketPath, close: async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

async function fictionalImage(format: "png" | "jpeg") {
  const image = sharp({ create: { width: 2, height: 3, channels: 3,
    background: { r: 17, g: 34, b: 51 } } });
  return format === "png" ? image.png().toBuffer() : image.jpeg().toBuffer();
}

function parser(socketPath: string) {
  return createParserSocketInspector({ socketPath,
    trustedWorkerUid: process.getuid!(), timeoutMs: 1000 });
}

async function rawRequest(socketPath: string, header: Buffer, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket: Socket = createConnection({ path: socketPath });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => resolve(Buffer.concat(chunks)));
    socket.once("connect", () => socket.end(Buffer.concat([header, payload])));
  });
}

describe("worker protocol with synthetic images only", () => {
  it("independently receives, hashes, and decodes PNG/JPEG; PDF remains unavailable", async () => {
    const service = await worker();
    try {
      await expect(parser(service.socketPath).inspect(await fictionalImage("png"), "image/png"))
        .resolves.toEqual({ status: "safe", pageCount: 1 });
      await expect(parser(service.socketPath).inspect(await fictionalImage("jpeg"), "image/jpeg"))
        .resolves.toEqual({ status: "safe", pageCount: 1 });
      await expect(parser(service.socketPath).inspect(
        Buffer.from("%PDF-1.7\nFICTIONAL WORKER TEST\n%%EOF"), "application/pdf"))
        .resolves.toEqual({ status: "rejected", pageCount: 0 });
    } finally { await service.close(); }
  });

  it("rejects a header digest that does not match exact received payload bytes", async () => {
    const service = await worker();
    try {
      const bytes = await fictionalImage("png");
      const request = createParserRequest({ mediaType: "image/png",
        sha256: "b".repeat(64), byteSize: bytes.length });
      const response = await rawRequest(service.socketPath,
        encodeParserRequestHeader(request), bytes);
      expect(parseParserReply(response.subarray(4), request)).toMatchObject({
        verdict: "rejected", code: "MALFORMED",
      });
      expect(response.readUInt32BE(0)).toBe(response.length - 4);
    } finally { await service.close(); }
  });

  it("returns no success for excess or missing request bytes", async () => {
    const service = await worker();
    try {
      const bytes = await fictionalImage("png");
      const request = createParserRequest({ mediaType: "image/png",
        sha256: "a".repeat(64), byteSize: bytes.length });
      const header = encodeParserRequestHeader(request);
      expect(await rawRequest(service.socketPath, header,
        Buffer.concat([bytes, Buffer.from("extra")]))).toHaveLength(0);
      expect(await rawRequest(service.socketPath, header,
        bytes.subarray(0, bytes.length - 1))).toHaveLength(0);
    } finally { await service.close(); }
  });
});
