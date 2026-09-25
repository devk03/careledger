import { describe, expect, it } from "vitest";

import { checkJpegContainer, JpegPreflightRejected } from "../src/ingest/jpegPreflight.js";

function segment(marker: number, payload: Buffer): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
}

function fictionalJpeg(extra: Buffer[] = [], entropy = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56])) {
  // This is a fictional marker fixture, not a claim of decodable JPEG pixels.
  const frame = Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
  const scan = Buffer.from([1, 1, 0, 0, 63, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...extra,
    segment(0xc0, frame), segment(0xda, scan), entropy, Buffer.from([0xff, 0xd9])]);
}

describe("JPEG marker preflight (not a decoder)", () => {
  it("walks a fictional one-frame marker stream and skips stuffed entropy bytes", () => {
    expect(checkJpegContainer(fictionalJpeg())).toEqual({ width: 1, height: 1, scanCount: 1 });
  });

  it("does not mistake an EOI marker inside an APP segment for the end", () => {
    const withMarkerInMetadata = fictionalJpeg([segment(0xe1, Buffer.from([0xff, 0xd9, 0x41]))]);
    expect(checkJpegContainer(withMarkerInMetadata).width).toBe(1);
    expect(() => checkJpegContainer(Buffer.concat([withMarkerInMetadata, Buffer.from("trailing")])))
      .toThrow(JpegPreflightRejected);
  });

  it("rejects trailing data, missing EOI, malformed segment length, and a second SOI", () => {
    const valid = fictionalJpeg();
    const invalidLength = Buffer.from(valid);
    invalidLength.writeUInt16BE(0xffff, 4);
    for (const bytes of [Buffer.concat([valid, Buffer.from("polyglot")]),
      valid.subarray(0, valid.length - 2), invalidLength,
      fictionalJpeg([Buffer.from([0xff, 0xd8])])]) {
      expect(() => checkJpegContainer(bytes)).toThrow(JpegPreflightRejected);
    }
  });

  it("rejects implausible frame geometry before a decoder sees it", () => {
    const bomb = fictionalJpeg();
    bomb.writeUInt16BE(20_000, 7);
    bomb.writeUInt16BE(20_000, 9);
    expect(() => checkJpegContainer(bomb)).toThrow(JpegPreflightRejected);
  });
});
