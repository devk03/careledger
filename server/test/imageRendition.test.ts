import sharp from "sharp";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { MAX_RENDITION_BYTES, renderImageInWorker } from "../src/ingest/imageDecoder.js";

it("returns a bounded, separately hashed rendition and preserves exact source bytes", async () => {
  const bytes = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#173951" } }).png().toBuffer();
  const before = Buffer.from(bytes); const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const pending = renderImageInWorker(bytes, "image/png"); bytes.fill(0); // The worker helper must own its input.
  const result = await pending; expect(result.verdict).toBe("safe");
  if (result.verdict !== "safe") throw new Error("Expected fictional rendition");
  expect(result.sourceSha256).toBe(sourceHash); expect(result.sourceWidth).toBe(2400);
  expect(result.rendition).toMatchObject({ width: 1600, height: 800, mimeType: "image/jpeg", autoOriented: true, background: "white" });
  const rendered = Buffer.from(result.rendition.data, "base64");
  expect(rendered.length).toBeLessThanOrEqual(MAX_RENDITION_BYTES);
  expect(createHash("sha256").update(rendered).digest("hex")).toBe(result.rendition.sha256);
  expect(result.rendition.sha256).not.toBe(sourceHash);
  expect((await sharp(before).metadata()).width).toBe(2400);
  expect((await sharp(rendered).metadata()).format).toBe("jpeg");
});

it("normalizes EXIF orientation, drops source metadata and does not enlarge small originals", async () => {
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#351971" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await renderImageInWorker(bytes, "image/jpeg"); expect(result.verdict).toBe("safe");
  if (result.verdict !== "safe") throw new Error("Expected fictional rendition");
  expect(result.rendition).toMatchObject({ width: 3, height: 2 });
  const metadata = await sharp(Buffer.from(result.rendition.data, "base64")).metadata();
  expect(metadata.exif).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
});

it("rejects corrupt, mismatched and polyglot source data before returning image content", async () => {
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#173951" } }).png().toBuffer();
  for (const [input, type] of [[bytes.subarray(0, -8), "image/png"], [bytes, "image/jpeg"],
    [Buffer.concat([bytes, Buffer.from("Invented trailing bytes")]), "image/png"]] as const)
    expect(await renderImageInWorker(input, type)).toEqual({ verdict: "rejected", code: "MALFORMED" });
});
