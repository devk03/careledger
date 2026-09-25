import { MAX_UPLOAD_BYTES } from "./admission.js";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./policy.js";

const MAX_MARKERS = 10_000;
const MAX_ENTROPY_MARKERS = 1_000_000;
const FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2]);
const OTHER_SEGMENTS = new Set([0xc4, 0xdb, 0xdd, 0xfe,
  ...Array.from({ length: 16 }, (_, index) => 0xe0 + index)]);

export class JpegPreflightRejected extends Error {
  constructor() { super("JPEG_PREFLIGHT_REJECTED"); }
}

export type JpegPreflight = Readonly<{ width: number; height: number; scanCount: number }>;

/**
 * Conservative marker walk. This checks container boundaries and dimensions,
 * not entropy decoding or pixel validity; the isolated decoder is mandatory.
 */
export function checkJpegContainer(input: Uint8Array): JpegPreflight {
  if (input.byteLength < 4 || input.byteLength > MAX_UPLOAD_BYTES)
    throw new JpegPreflightRejected();
  const bytes = Buffer.from(input);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new JpegPreflightRejected();

  let offset = 2;
  let markerCount = 0;
  let entropyMarkers = 0;
  let inScan = false;
  let seenFrame = false;
  let scanCount = 0;
  let width = 0;
  let height = 0;

  while (offset < bytes.length) {
    if (inScan) {
      const markerStart = bytes.indexOf(0xff, offset);
      if (markerStart === -1) throw new JpegPreflightRejected();
      let codeAt = markerStart + 1;
      while (bytes[codeAt] === 0xff) codeAt += 1;
      if (codeAt >= bytes.length) throw new JpegPreflightRejected();
      entropyMarkers += 1;
      if (entropyMarkers > MAX_ENTROPY_MARKERS) throw new JpegPreflightRejected();
      const code = bytes[codeAt]!;
      if (code === 0 || (code >= 0xd0 && code <= 0xd7)) {
        offset = codeAt + 1;
        continue;
      }
      inScan = false;
      offset = markerStart;
      continue;
    }

    if (bytes[offset] !== 0xff) throw new JpegPreflightRejected();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new JpegPreflightRejected();
    const marker = bytes[offset]!;
    offset += 1;
    markerCount += 1;
    if (markerCount > MAX_MARKERS || marker === 0 || marker === 0xd8 ||
      (marker >= 0xd0 && marker <= 0xd7)) throw new JpegPreflightRejected();
    if (marker === 0xd9) {
      if (!seenFrame || scanCount === 0 || offset !== bytes.length)
        throw new JpegPreflightRejected();
      return { width, height, scanCount };
    }
    if (!FRAME_MARKERS.has(marker) && marker !== 0xda && !OTHER_SEGMENTS.has(marker))
      throw new JpegPreflightRejected();
    if (offset + 2 > bytes.length) throw new JpegPreflightRejected();
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || segmentLength > bytes.length - offset)
      throw new JpegPreflightRejected();
    const end = offset + segmentLength;

    if (FRAME_MARKERS.has(marker)) {
      if (seenFrame || segmentLength < 11) throw new JpegPreflightRejected();
      const precision = bytes[offset + 2]!;
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      const components = bytes[offset + 7]!;
      if ((precision !== 8 && precision !== 12) || components < 1 || components > 4 ||
        segmentLength !== 8 + 3 * components ||
        width < 1 || height < 1 || width > MAX_IMAGE_DIMENSION ||
        height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS)
        throw new JpegPreflightRejected();
      seenFrame = true;
    } else if (marker === 0xda) {
      if (!seenFrame || segmentLength < 8) throw new JpegPreflightRejected();
      const components = bytes[offset + 2]!;
      if (components < 1 || components > 4 || segmentLength !== 6 + 2 * components)
        throw new JpegPreflightRejected();
      scanCount += 1;
      inScan = true;
    }
    offset = end;
  }
  throw new JpegPreflightRejected();
}
