import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { decodeImageInSubprocess } from "../src/ingest/imageDecodeProcess.js";

const childScript = join(process.cwd(), "dist/ingest/imageDecodeChild.js");
const neverExit = join(process.cwd(), "test/fixtures/neverExit.mjs");

async function fictionalPng() {
  return sharp({ create: { width: 2, height: 3, channels: 3,
    background: { r: 17, g: 34, b: 51 } } }).png().toBuffer();
}

describe("one-job image decode child process", () => {
  it("decodes fictional pixels in a short-lived child and validates its reply", async () => {
    await expect(decodeImageInSubprocess(await fictionalPng(), "image/png",
      { scriptPath: childScript, timeoutMs: 2000 }))
      .resolves.toEqual({ verdict: "safe", pageCount: 1,
        frameCount: 1, width: 2, height: 3 });
  });

  it("SIGKILLs a stalled child on deadline or abort, then returns rejected", async () => {
    const input = await fictionalPng();
    await expect(decodeImageInSubprocess(input, "image/png",
      { scriptPath: neverExit, timeoutMs: 100 }))
      .resolves.toEqual({ verdict: "rejected", code: "MALFORMED" });
    const controller = new AbortController();
    const pending = decodeImageInSubprocess(input, "image/png",
      { scriptPath: neverExit, timeoutMs: 2000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(pending).resolves.toEqual({ verdict: "rejected", code: "MALFORMED" });
    await expect(decodeImageInSubprocess(input, "image/png",
      { scriptPath: neverExit, timeoutMs: 2000, signal: controller.signal }))
      .resolves.toEqual({ verdict: "rejected", code: "MALFORMED" });
  });

  it("fails closed before spawn when the program path is absent", async () => {
    const absent = join(await mkdtemp(join(tmpdir(), "adeno-no-child-")), "none.js");
    await expect(decodeImageInSubprocess(await fictionalPng(), "image/png",
      { scriptPath: absent, timeoutMs: 1000 }))
      .resolves.toEqual({ verdict: "rejected", code: "MALFORMED" });
  });
});
