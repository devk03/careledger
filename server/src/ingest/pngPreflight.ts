import { crc32 } from "node:zlib";

import { MAX_UPLOAD_BYTES } from "./admission.js";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHUNKS = 10_000;
const MAX_DIMENSION = 20_000;
const MAX_PIXELS = 40_000_000;

export class PngPreflightRejected extends Error {
  constructor() { super("PNG_PREFLIGHT_REJECTED"); }
}

export type PngPreflight = Readonly<{
  width: number;
  height: number;
  interlaced: boolean;
  chunkCount: number;
}>;

/**
 * Bounded container checks only. This never decompresses or renders IDAT and
 * cannot stand in for isolated image decoding/structural inspection.
 */
export function checkPngContainer(input: Uint8Array): PngPreflight {
  if (input.byteLength < SIGNATURE.length + 12 || input.byteLength > MAX_UPLOAD_BYTES)
    throw new PngPreflightRejected();
  const bytes = Buffer.from(input);
  if (!bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE))
    throw new PngPreflightRejected();

  let offset = SIGNATURE.length;
  let chunkCount = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlaced = false;
  let seenHeader = false;
  let seenPalette = false;
  let seenData = false;
  let endedData = false;
  let dataBytes = 0;

  while (offset < bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_CHUNKS || offset + 12 > bytes.length) throw new PngPreflightRejected();
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || length > bytes.length - offset - 12)
      throw new PngPreflightRejected();
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2]?.toUpperCase())
      throw new PngPreflightRejected();
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(payload, crc32(typeBytes)) !== expectedCrc) throw new PngPreflightRejected();
    offset += 12 + length;

    if (!seenHeader && type !== "IHDR") throw new PngPreflightRejected();
    if (type === "IHDR") {
      if (seenHeader || length !== 13 || chunkCount !== 1) throw new PngPreflightRejected();
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bitDepth = payload[8]!;
      colorType = payload[9]!;
      const allowedDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8],
        4: [8, 16], 6: [8, 16],
      };
      if (width < 1 || height < 1 || width > MAX_DIMENSION ||
        height > MAX_DIMENSION || width * height > MAX_PIXELS ||
        !allowedDepths[colorType]?.includes(bitDepth) || payload[10] !== 0 ||
        payload[11] !== 0 || (payload[12] !== 0 && payload[12] !== 1))
        throw new PngPreflightRejected();
      interlaced = payload[12] === 1;
      seenHeader = true;
    } else if (type === "PLTE") {
      if (seenPalette || seenData || length < 3 || length > 768 || length % 3 !== 0 ||
        colorType === 0 || colorType === 4 ||
        (colorType === 3 && length / 3 > 2 ** bitDepth)) throw new PngPreflightRejected();
      seenPalette = true;
    } else if (type === "IDAT") {
      if (endedData || (colorType === 3 && !seenPalette)) throw new PngPreflightRejected();
      seenData = true;
      dataBytes += length;
    } else if (type === "IEND") {
      if (!seenData || dataBytes === 0 || length !== 0 || offset !== bytes.length)
        throw new PngPreflightRejected();
      return { width, height, interlaced, chunkCount };
    } else {
      if (type === "acTL" || type === "fcTL" || type === "fdAT" ||
        type[0] === type[0]?.toUpperCase()) throw new PngPreflightRejected();
      if (seenData) endedData = true;
    }
  }
  throw new PngPreflightRejected();
}
