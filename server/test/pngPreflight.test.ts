import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { checkPngContainer, PngPreflightRejected } from "../src/ingest/pngPreflight.js";
import { MAX_UPLOAD_BYTES } from "../src/ingest/admission.js";

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, payload: Buffer): Buffer {
  const label = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload, crc32(label)));
  return Buffer.concat([length, label, payload, checksum]);
}

function fictionalPng(extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = deflateSync(Buffer.from([0, 0x11, 0x22, 0x33, 0xff]));
  return Buffer.concat([signature, chunk("IHDR", header), ...extra,
    chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

describe("PNG container preflight (not a decoder)", () => {
  it("accepts a small, wholly fictional well-framed PNG", () => {
    expect(checkPngContainer(fictionalPng())).toEqual({
      width: 1, height: 1, interlaced: false, chunkCount: 3,
    });
  });

  it("rejects CRC changes, trailing bytes, animation, and unknown critical chunks", () => {
    const corrupted = fictionalPng();
    corrupted[corrupted.length - 5] = corrupted[corrupted.length - 5]! ^ 1;
    for (const bytes of [corrupted, Buffer.concat([fictionalPng(), Buffer.from("extra")]),
      fictionalPng([chunk("acTL", Buffer.alloc(8))]),
      fictionalPng([chunk("ABCD", Buffer.alloc(0))])]) {
      expect(() => checkPngContainer(bytes)).toThrow(PngPreflightRejected);
    }
  });

  it("rejects pixel bombs and missing or nonconsecutive image data", () => {
    const huge = fictionalPng();
    huge.writeUInt32BE(20_000, 16);
    huge.writeUInt32BE(20_000, 20);
    const type = huge.subarray(12, 16);
    const payload = huge.subarray(16, 29);
    huge.writeUInt32BE(crc32(payload, crc32(type)), 29);
    expect(() => checkPngContainer(huge)).toThrow(PngPreflightRejected);
    expect(() => checkPngContainer(Buffer.concat([signature,
      chunk("IHDR", fictionalPng().subarray(16, 29)), chunk("IEND", Buffer.alloc(0))])))
      .toThrow(PngPreflightRejected);
    const firstData = chunk("IDAT", deflateSync(Buffer.from([0, 0x11, 0x22, 0x33, 0xff])));
    const header = fictionalPng().subarray(8, 33);
    expect(() => checkPngContainer(Buffer.concat([signature, header, firstData,
      chunk("tEXt", Buffer.from("fictional")), firstData,
      chunk("IEND", Buffer.alloc(0))]))).toThrow(PngPreflightRejected);
  });

  it("rejects oversized input before making a copy", () => {
    const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    expect(() => checkPngContainer(oversized)).toThrow(PngPreflightRejected);
  });
});
