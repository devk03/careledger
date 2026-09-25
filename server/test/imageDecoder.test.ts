import sharp from "sharp";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";

import { decodeImageInWorker } from "../src/ingest/imageDecoder.js";
import { checkPngContainer } from "../src/ingest/pngPreflight.js";

async function fictionalImage(format: "png" | "jpeg") {
  const image = sharp({ create: { width: 2, height: 3, channels: 3,
    background: { r: 17, g: 34, b: 51 } } });
  return format === "png" ? image.png().toBuffer() : image.jpeg().toBuffer();
}

describe("worker-only image decoder", () => {
  it("fully decodes fictional PNG and JPEG pixels after container preflight", async () => {
    await expect(decodeImageInWorker(await fictionalImage("png"), "image/png"))
      .resolves.toEqual({ verdict: "safe", pageCount: 1, frameCount: 1,
        width: 2, height: 3 });
    await expect(decodeImageInWorker(await fictionalImage("jpeg"), "image/jpeg"))
      .resolves.toEqual({ verdict: "safe", pageCount: 1, frameCount: 1,
        width: 2, height: 3 });
  });

  it("rejects type confusion, container corruption, and polyglot tails", async () => {
    const png = await fictionalImage("png");
    const jpeg = await fictionalImage("jpeg");
    const corruptedPng = Buffer.from(png);
    corruptedPng[corruptedPng.length - 5] = corruptedPng[corruptedPng.length - 5]! ^ 1;
    await expect(decodeImageInWorker(jpeg, "image/webp" as "image/jpeg"))
      .resolves.toEqual({ verdict: "rejected", code: "MALFORMED" });
    for (const [bytes, type] of [
      [png, "image/jpeg"], [jpeg, "image/png"],
      [corruptedPng, "image/png"],
      [Buffer.concat([jpeg, Buffer.from("fictional trailing bytes")]), "image/jpeg"],
      [jpeg.subarray(0, jpeg.length - 2), "image/jpeg"],
    ] as const) {
      const result = await decodeImageInWorker(bytes, type);
      expect(result).toEqual({ verdict: "rejected", code: "MALFORMED" });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("rejects corrupt compressed pixels even when PNG framing and CRC are repaired", async () => {
    const bytes = Buffer.from(await fictionalImage("png"));
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.subarray(offset + 4, offset + 8);
      if (type.toString("ascii") === "IDAT") {
        bytes[offset + 8] = 0xff;
        const payload = bytes.subarray(offset + 8, offset + 8 + length);
        bytes.writeUInt32BE(crc32(payload, crc32(type)), offset + 8 + length);
        break;
      }
      offset += 12 + length;
    }
    expect(checkPngContainer(bytes).width).toBe(2);
    await expect(decodeImageInWorker(bytes, "image/png"))
      .resolves.toEqual({ verdict: "rejected", code: "MALFORMED" });
  });
});
