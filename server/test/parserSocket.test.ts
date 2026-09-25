import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_UPLOAD_BYTES } from "../src/ingest/admission.js";
import { MAX_PARSER_HEADER_BYTES, PARSER_WORKER_VERSION,
  parseParserRequestHeader, type ParserRequest } from "../src/ingest/parserProtocol.js";
import { createParserSocketInspector } from "../src/ingest/parserSocket.js";

const fictionalPdf = Buffer.from("%PDF-1.7\nFICTIONAL SOCKET TEST\n%%EOF");

function frame(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json]);
}

type WorkerMode = "safe" | "wrong-digest" | "trailing" | "truncated" | "silent" | "early";

async function fakeWorker(mode: WorkerMode) {
  const directory = await mkdtemp(join(tmpdir(), "adeno-fictional-parser-socket-"));
  const socketPath = join(directory, "parser.sock");
  const peers = new Set<Socket>();
  let receivedResolve!: (value: Buffer) => void;
  const received = new Promise<Buffer>((resolve) => { receivedResolve = resolve; });
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    if (mode === "early") {
      socket.end(frame({ verdict: "safe" }));
      return;
    }
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
    });
    socket.on("end", () => {
      if (data.length < 4) return;
      const headerLength = data.readUInt32BE(0);
      if (headerLength > MAX_PARSER_HEADER_BYTES || data.length < 4 + headerLength) return;
      const request: ParserRequest = parseParserRequestHeader(data.subarray(4, 4 + headerLength));
      const payloadStart = 4 + headerLength;
      if (data.length !== payloadStart + request.byteSize) return socket.destroy();
      const payload = data.subarray(payloadStart, payloadStart + request.byteSize);
      receivedResolve(Buffer.from(payload));
      if (mode === "silent") return;
      // This fake worker verifies the exact received bytes; it does not parse
      // the fictional PDF and is never used as a production inspector.
      if (createHash("sha256").update(payload).digest("hex") !== request.sha256) {
        socket.destroy();
        return;
      }
      const reply = { ...request, workerVersion: PARSER_WORKER_VERSION,
        sha256: mode === "wrong-digest" ? "b".repeat(64) : request.sha256,
        verdict: "safe", pageCount: 1, objectCount: 3,
        maxPageWidthPoints: 612, maxPageHeightPoints: 792,
        encrypted: false, activeContent: false };
      const output = frame(reply);
      if (mode === "trailing") socket.end(Buffer.concat([output, Buffer.from("x")]));
      else if (mode === "truncated") socket.end(output.subarray(0, output.length - 1));
      else socket.end(output);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  return { socketPath, received, close: async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

function inspector(socketPath: string, timeoutMs = 300) {
  return createParserSocketInspector({ socketPath,
    trustedWorkerUid: process.getuid!(), timeoutMs });
}

describe("bounded parser Unix-socket transport, with a fictional worker", () => {
  it("sends exact bytes and accepts only a complete request-bound reply", async () => {
    const worker = await fakeWorker("safe");
    try {
      await expect(inspector(worker.socketPath).inspect(fictionalPdf, "application/pdf"))
        .resolves.toEqual({ status: "safe", pageCount: 1 });
      expect(await worker.received).toEqual(fictionalPdf);
    } finally { await worker.close(); }
  });

  it("rejects mismatched, extra, truncated, and premature replies", async () => {
    for (const mode of ["wrong-digest", "trailing", "truncated", "early"] as const) {
      const worker = await fakeWorker(mode);
      try {
        const bytes = mode === "early" ? Buffer.alloc(10_000_000, 0x46) : fictionalPdf;
        await expect(inspector(worker.socketPath).inspect(bytes, "application/pdf"))
          .resolves.toEqual({ status: "rejected", pageCount: 0 });
      } finally { await worker.close(); }
    }
  });

  it("fails closed on timeout, absent socket, and oversized input", async () => {
    const worker = await fakeWorker("silent");
    try {
      await expect(inspector(worker.socketPath, 30).inspect(fictionalPdf, "application/pdf"))
        .resolves.toEqual({ status: "rejected", pageCount: 0 });
      await expect(inspector(worker.socketPath).inspect(Buffer.alloc(MAX_UPLOAD_BYTES + 1),
        "application/pdf")).resolves.toEqual({ status: "rejected", pageCount: 0 });
    } finally { await worker.close(); }
    const absent = join(await mkdtemp(join(tmpdir(), "adeno-absent-parser-")), "none.sock");
    await expect(inspector(absent).inspect(fictionalPdf, "application/pdf"))
      .resolves.toEqual({ status: "rejected", pageCount: 0 });
  });

  it("cannot turn later failures into success by mutating a prior rejection", async () => {
    const absent = join(await mkdtemp(join(tmpdir(), "adeno-immutable-rejection-")), "none.sock");
    const parser = inspector(absent);
    const first = await parser.inspect(fictionalPdf, "application/pdf");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, "status", "safe")).toBe(false);
    expect(Reflect.set(first, "pageCount", 1)).toBe(false);
    await expect(parser.inspect(fictionalPdf, "application/pdf"))
      .resolves.toEqual({ status: "rejected", pageCount: 0 });
  });

  it("fails closed at the per-adapter concurrency cap", async () => {
    const worker = await fakeWorker("silent");
    try {
      const parser = inspector(worker.socketPath, 200);
      const first = parser.inspect(fictionalPdf, "application/pdf");
      await worker.received;
      await expect(parser.inspect(fictionalPdf, "application/pdf"))
        .resolves.toEqual({ status: "rejected", pageCount: 0 });
      await expect(first).resolves.toEqual({ status: "rejected", pageCount: 0 });
    } finally { await worker.close(); }
  });
});
