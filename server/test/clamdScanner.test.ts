import { createServer, type Server } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createClamdScanner } from "../src/ingest/clamdScanner.js";
import { MAX_UPLOAD_BYTES } from "../src/ingest/admission.js";

const fictionalBytes = Buffer.from("fictional scanner protocol fixture");

async function fakeDaemon(reply: Buffer | null): Promise<{
  socketPath: string;
  server: Server;
  received: Promise<Buffer>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "adeno-fictional-clamd-"));
  const socketPath = join(directory, "clamd.sock");
  let receivedResolve!: (value: Buffer) => void;
  const received = new Promise<Buffer>((resolve) => { receivedResolve = resolve; });
  const server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!data.subarray(0, 10).equals(Buffer.from("zINSTREAM\0"))) return;
      let cursor = 10;
      const chunks: Buffer[] = [];
      while (cursor + 4 <= data.length) {
        const length = data.readUInt32BE(cursor);
        if (cursor + 4 + length > data.length) return;
        cursor += 4;
        if (length === 0) {
          receivedResolve(Buffer.concat(chunks));
          if (reply !== null) socket.write(reply);
          return;
        }
        chunks.push(data.subarray(cursor, cursor + length));
        cursor += length;
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { socketPath, server, received };
}

async function close(server: Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("local clamd INSTREAM adapter", () => {
  it("returns clean only after a complete protocol success response", async () => {
    const daemon = await fakeDaemon(Buffer.from("stream: OK\0"));
    try {
      const scanner = createClamdScanner({ socketPath: daemon.socketPath });
      await expect(scanner.scan(fictionalBytes, "application/pdf"))
        .resolves.toEqual({ verdict: "clean", engine: "clamd" });
      expect(await daemon.received).toEqual(fictionalBytes);
    } finally {
      await close(daemon.server);
    }
  });

  it("recognizes detection without returning a signature or document bytes", async () => {
    const daemon = await fakeDaemon(Buffer.from("stream: Fictional.Test FOUND\0"));
    try {
      const scanner = createClamdScanner({ socketPath: daemon.socketPath });
      await expect(scanner.scan(fictionalBytes, "image/png"))
        .resolves.toEqual({ verdict: "detected", engine: "clamd" });
    } finally {
      await close(daemon.server);
    }
  });

  it("uses bounded stream chunks and refuses an oversized input", async () => {
    const daemon = await fakeDaemon(Buffer.from("stream: OK\0"));
    try {
      const scanner = createClamdScanner({ socketPath: daemon.socketPath });
      const multiChunk = Buffer.alloc(140_000, 0x46);
      await expect(scanner.scan(multiChunk, "image/png"))
        .resolves.toEqual({ verdict: "clean", engine: "clamd" });
      expect(await daemon.received).toEqual(multiChunk);
      await expect(scanner.scan(Buffer.alloc(MAX_UPLOAD_BYTES + 1), "image/png"))
        .resolves.toEqual({ verdict: "unavailable", engine: "clamd" });
    } finally {
      await close(daemon.server);
    }
  });

  it("fails closed on daemon errors, malformed replies, and timeouts", async () => {
    for (const reply of [Buffer.from("stream: size limit exceeded. ERROR\0"),
      Buffer.from("stream: OK\0junk"), Buffer.from("stream: OK"), null]) {
      const daemon = await fakeDaemon(reply);
      try {
        const scanner = createClamdScanner({ socketPath: daemon.socketPath, timeoutMs: 100 });
        await expect(scanner.scan(fictionalBytes, "image/jpeg"))
          .resolves.toEqual({ verdict: "unavailable", engine: "clamd" });
      } finally {
        await close(daemon.server);
      }
    }
    const absent = join(await mkdtemp(join(tmpdir(), "adeno-absent-clamd-")), "none.sock");
    await expect(createClamdScanner({ socketPath: absent }).scan(fictionalBytes, "image/jpeg"))
      .resolves.toEqual({ verdict: "unavailable", engine: "clamd" });
  });
});
