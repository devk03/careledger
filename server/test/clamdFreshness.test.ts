import { createServer, type Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createClamdScanner } from "../src/ingest/clamdScanner.js";

function freshVersion() {
  const date = new Date().toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4");
  return Buffer.from(`ClamAV 1.5.4/28153/${date}\0`);
}
async function daemon() {
  const socketPath = join(await mkdtemp(join(tmpdir(), "adeno-fictional-signature-age-")), "clamd.sock");
  let version: Buffer | null = freshVersion(); let streams = 0; let queries = 0;
  let beforeReply = () => {};
  const peers = new Set<Socket>();
  const server = createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket));
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.equals(Buffer.from("zVERSION\0"))) {
        queries++; if (version) socket.end(version); return;
      }
      if (!data.subarray(0, 10).equals(Buffer.from("zINSTREAM\0"))) return;
      let offset = 10;
      while (offset + 4 <= data.length) {
        const length = data.readUInt32BE(offset); offset += 4;
        if (offset + length > data.length) return;
        if (!length) { streams++; beforeReply(); socket.end(Buffer.from("stream: OK\0")); return; }
        offset += length;
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  return { socketPath, setVersion: (value: Buffer | null) => { version = value; },
    setBeforeReply: (value: () => void) => { beforeReply = value; },
    counts: () => ({ streams, queries }), close: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

it("rechecks loaded signatures on each scan and sends no document bytes after stale or future metadata", async () => {
  const worker = await daemon();
  const scanner = createClamdScanner({ socketPath: worker.socketPath, timeoutMs: 1000 });
  try {
    expect((await scanner.scan(Buffer.from("independently invented bytes"), "image/png")).verdict).toBe("clean");
    for (const date of ["Sat Jan 01 00:00:00 2022", "Fri Jan 01 00:00:00 2100"]) {
      worker.setVersion(Buffer.from(`ClamAV 1.5.4/28153/${date}\0`));
      expect((await scanner.scan(Buffer.from("never sent"), "image/png")).verdict).toBe("unavailable");
    }
    expect(worker.counts()).toEqual({ streams: 1, queries: 3 });
    worker.setVersion(freshVersion());
    expect((await scanner.scan(Buffer.from("invented after refresh"), "image/png")).verdict).toBe("clean");
    expect(worker.counts()).toEqual({ streams: 2, queries: 4 });
  } finally { await worker.close(); }
});

it("discards a clean result when signatures expire during the document scan", async () => {
  const worker = await daemon();
  const initialNow = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(initialNow);
  const scanner = createClamdScanner({ socketPath: worker.socketPath, timeoutMs: 1000 });
  try {
    worker.setBeforeReply(() => { clock.mockReturnValue(initialNow + 48 * 60 * 60 * 1000 + 2000); });
    expect((await scanner.scan(Buffer.from("invented slow scan"), "image/png")).verdict).toBe("unavailable");
    expect(worker.counts()).toEqual({ streams: 1, queries: 1 });
  } finally { clock.mockRestore(); await worker.close(); }
});

it("denies malformed, oversized, truncated, impossible-date and absent version replies", async () => {
  const worker = await daemon();
  const scanner = createClamdScanner({ socketPath: worker.socketPath, timeoutMs: 60 });
  try {
    for (const reply of [Buffer.from("stream: OK\0"), Buffer.alloc(1025, 65),
      freshVersion().subarray(0, -1), Buffer.concat([freshVersion(), Buffer.from("extra")]),
      Buffer.from("ClamAV 1.5.4/28153/Wed Feb 30 00:00:00 2026\0"), null]) {
      worker.setVersion(reply);
      expect((await scanner.scan(Buffer.from("never sent"), "image/png")).verdict).toBe("unavailable");
    }
    expect(worker.counts().streams).toBe(0);
    worker.setVersion(freshVersion());
    expect((await scanner.scan(Buffer.from("slot released"), "image/png")).verdict).toBe("clean");
  } finally { await worker.close(); }
});
