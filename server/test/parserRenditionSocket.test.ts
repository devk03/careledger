import { randomBytes, createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { createParserSocketRenderer } from "../src/ingest/parserRenditionSocket.js";
import { createParserSocketInspector } from "../src/ingest/parserSocket.js";
import { createParserRequest, encodeParserRequestHeader, parseParserRenditionReply } from "../src/ingest/parserProtocol.js";
import { startParserWorkerServer } from "../src/ingest/parserWorker.js";

const rejected = { verdict: "rejected", code: "MALFORMED" };
async function image() { return sharp({ create: { width: 2, height: 3, channels: 3, background: "#173951" } }).png().toBuffer(); }
async function fixture() {
  const socketPath = join(await mkdtemp(join(tmpdir(), "adeno-rendition-")), "parser.sock");
  const server = await startParserWorkerServer({ socketPath, timeoutMs: 3000 },
    { childScriptPath: join(process.cwd(), "dist/ingest/imageDecodeChild.js") });
  return { socketPath, server, render: createParserSocketRenderer({ socketPath, trustedWorkerUid: process.getuid!(), timeoutMs: 3000 }),
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

it("uses the real isolated-worker protocol for a large rendition while ordinary inspection stays unchanged", async () => {
  const state = await fixture();
  try {
    const bytes = await sharp(randomBytes(800 * 600 * 3), { raw: { width: 800, height: 600, channels: 3 } }).png().toBuffer();
    const result = await state.render(bytes, "image/png"); expect(result.verdict).toBe("safe");
    if (result.verdict !== "safe") throw new Error("Expected generated rendition");
    expect(result.sourceSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.rendition.data.length).toBeGreaterThan(2048);
    const inspector = createParserSocketInspector({ socketPath: state.socketPath, trustedWorkerUid: process.getuid!(), timeoutMs: 3000 });
    expect(await inspector.inspect(bytes, "image/png")).toEqual({ status: "safe", pageCount: 1 });
    const request = createParserRequest({ purpose: "rendition", mediaType: "image/png", sha256: result.sourceSha256, byteSize: bytes.length });
    expect(() => parseParserRenditionReply(Buffer.from(JSON.stringify({ ...request, workerVersion: "adeno-parser-1", result,
      requestId: "33333333-3333-4333-8333-333333333333" })), request)).toThrow();
  } finally { await state.close(); }
});

it("rejects corrupt input and an unsafe socket directory without returning source pixels", async () => {
  const state = await fixture();
  try {
    const bytes = await image(); expect(await state.render(bytes.subarray(0, -8), "image/png")).toEqual(rejected);
    await chmod(join(state.socketPath, ".."), 0o777);
    expect(await state.render(bytes, "image/png")).toEqual(rejected);
  } finally { await state.close(); }
});

it("rejects an oversized declared frame and releases its client slot", async () => {
  const socketPath = join(await mkdtemp(join(tmpdir(), "adeno-frame-")), "parser.sock");
  let calls = 0;
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.resume(); socket.on("end", () => { calls++; const frame = Buffer.alloc(4); frame.writeUInt32BE(0x7fffffff); socket.end(frame); });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  const render = createParserSocketRenderer({ socketPath, trustedWorkerUid: process.getuid!(), timeoutMs: 200 });
  try { const bytes = await image(); expect(await render(bytes, "image/png")).toEqual(rejected);
    expect(await render(bytes, "image/png")).toEqual(rejected); expect(calls).toBe(2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("rejects a forged input digest at the worker before invoking the renderer", async () => {
  const state = await fixture();
  try {
    const bytes = await image(); const request = createParserRequest({ purpose: "rendition", mediaType: "image/png", byteSize: bytes.length, sha256: "f".repeat(64) });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => { const socket = createConnection(state.socketPath);
      socket.on("error", reject); socket.on("data", chunk => chunks.push(chunk)); socket.on("end", resolve);
      socket.once("connect", () => socket.end(Buffer.concat([encodeParserRequestHeader(request), bytes]))); });
    expect(parseParserRenditionReply(Buffer.concat(chunks).subarray(4), request)).toEqual(rejected);
  } finally { await state.close(); }
});
