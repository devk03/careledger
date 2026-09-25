import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { checkParserLiveness, startParserHealthServer } from
  "../src/ingest/parserHealthSocket.js";
import { createParserSocketInspector } from "../src/ingest/parserSocket.js";
import { startParserWorkerServer } from "../src/ingest/parserWorker.js";

describe("synthetic parser liveness probe", () => {
  it("fails closed when no worker socket exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adeno-fictional-health-absent-"));
    await expect(checkParserLiveness(join(directory, "health.sock")))
      .resolves.toBe(false);
  });

  it("responds through a separate private socket while document decode is busy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adeno-fictional-health-live-"));
    const parserPath = join(directory, "parser.sock");
    const healthPath = join(directory, "health.sock");
    let startDecode!: () => void;
    const decoding = new Promise<void>((resolve) => { startDecode = resolve; });
    let finishDecode!: () => void;
    const finished = new Promise<void>((resolve) => { finishDecode = resolve; });
    const parser = await startParserWorkerServer({ socketPath: parserPath, timeoutMs: 5000 }, {
      decodeImage: async () => {
        startDecode();
        await finished;
        return { verdict: "safe", pageCount: 1, frameCount: 1, width: 2, height: 3 };
      },
    });
    const health = await startParserHealthServer(healthPath);
    try {
      const bytes = await sharp({ create: { width: 2, height: 3, channels: 3,
        background: { r: 17, g: 34, b: 51 } } }).png().toBuffer();
      const pending = createParserSocketInspector({ socketPath: parserPath,
        trustedWorkerUid: process.getuid!(), timeoutMs: 5000 })
        .inspect(bytes, "image/png");
      await decoding;
      await expect(checkParserLiveness(healthPath)).resolves.toBe(true);
      finishDecode();
      await expect(pending).resolves.toEqual({ status: "safe", pageCount: 1 });
    } finally {
      finishDecode();
      await new Promise<void>((resolve) => health.close(() => resolve()));
      await new Promise<void>((resolve) => parser.close(() => resolve()));
    }
  });
});
