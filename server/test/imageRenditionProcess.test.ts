import sharp from "sharp";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderImageInSubprocess } from "../src/ingest/imageDecodeProcess.js";
import { parseImageRendition } from "../src/ingest/imageRenditionProtocol.js";

const scriptPath = join(process.cwd(), "dist/ingest/imageDecodeChild.js");
const rejected = { verdict: "rejected", code: "MALFORMED" };
async function image() {
  return sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#173951" } }).png().toBuffer();
}

it("renders in a real short-lived child and binds exact source and rendition digests", async () => {
  const bytes = await image(); const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const result = await renderImageInSubprocess(bytes, "image/png", { scriptPath, timeoutMs: 3000 });
  expect(result.verdict).toBe("safe");
  if (result.verdict !== "safe") throw new Error("Expected fictional rendition");
  expect(result.sourceSha256).toBe(sourceSha256); expect(result.rendition).toMatchObject({ width: 1600, height: 800, mimeType: "image/jpeg" });
  const rendered = Buffer.from(result.rendition.data, "base64");
  expect(createHash("sha256").update(rendered).digest("hex")).toBe(result.rendition.sha256);
  expect((await sharp(rendered).metadata()).format).toBe("jpeg");
  for (const invalid of [
    { ...result, sourceSha256: "b".repeat(64) },
    { ...result, sourceWidth: 1, sourceHeight: 1 },
    { ...result, rendition: { ...result.rendition, sha256: "c".repeat(64) } },
    { ...result, rendition: { ...result.rendition, data: result.rendition.data + "!" } },
    { ...result, rendition: { ...result.rendition, width: 20000 } },
  ]) expect(parseImageRendition(invalid, sourceSha256)).toEqual(rejected);
});

it("snapshots caller-owned bytes before async script checks and refuses corrupt input", async () => {
  const bytes = await image(); const hash = createHash("sha256").update(bytes).digest("hex");
  const pending = renderImageInSubprocess(bytes, "image/png", { scriptPath, timeoutMs: 3000 }); bytes.fill(0);
  const result = await pending; expect(result).toMatchObject({ verdict: "safe", sourceSha256: hash });
  expect(await renderImageInSubprocess(bytes, "image/png", { scriptPath, timeoutMs: 3000 })).toEqual(rejected);
});

it("terminates stalled or cancelled render children instead of leaving an unbounded job", async () => {
  const bytes = await image(); const neverExit = join(process.cwd(), "test/fixtures/neverExit.mjs");
  expect(await renderImageInSubprocess(bytes, "image/png", { scriptPath: neverExit, timeoutMs: 100 })).toEqual(rejected);
  const controller = new AbortController();
  const pending = renderImageInSubprocess(bytes, "image/png", { scriptPath: neverExit, timeoutMs: 3000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  expect(await pending).toEqual(rejected);
  expect(await renderImageInSubprocess(bytes, "image/png", { scriptPath, timeoutMs: 3000, signal: controller.signal })).toEqual(rejected);
});

it("terminates an overflowing reply before the longer process deadline", async () => {
  const result = await renderImageInSubprocess(await image(), "image/png", {
    scriptPath: join(process.cwd(), "test/fixtures/oversizedImageReply.mjs"), timeoutMs: 10000 });
  expect(result).toEqual(rejected);
}, 3000);
