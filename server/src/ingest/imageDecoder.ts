import sharp from "sharp";

import { MAX_UPLOAD_BYTES } from "./admission.js";
import { checkJpegContainer } from "./jpegPreflight.js";
import { checkPngContainer } from "./pngPreflight.js";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./policy.js";

export type ImageMediaType = "image/jpeg" | "image/png";
export type ImageDecodeResult = Readonly<{
  verdict: "safe";
  pageCount: 1;
  frameCount: 1;
  width: number;
  height: number;
}> | Readonly<{ verdict: "rejected"; code: "MALFORMED" }>;

const rejected = Object.freeze({ verdict: "rejected" as const, code: "MALFORMED" as const });

/**
 * Decoder implementation for a future OS-isolated parser helper only. Running
 * this in the Express process does not create a sandbox or approve an upload.
 */
export async function decodeImageInWorker(
  input: Uint8Array, mediaType: ImageMediaType,
): Promise<ImageDecodeResult> {
  if ((mediaType !== "image/jpeg" && mediaType !== "image/png") ||
    input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES) return rejected;
  const bytes = Buffer.from(input);
  try {
    const container = mediaType === "image/png"
      ? checkPngContainer(bytes) : checkJpegContainer(bytes);
    const options = { failOn: "warning" as const, limitInputPixels: MAX_IMAGE_PIXELS,
      limitInputChannels: 4, animated: true };
    const metadata = await sharp(bytes, options).metadata();
    const expectedFormat = mediaType === "image/png" ? "png" : "jpeg";
    if (metadata.format !== expectedFormat || metadata.width !== container.width ||
      metadata.height !== container.height || (metadata.pages ?? 1) !== 1 ||
      metadata.width < 1 || metadata.height < 1 ||
      metadata.width > MAX_IMAGE_DIMENSION || metadata.height > MAX_IMAGE_DIMENSION ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS) return rejected;
    // metadata() only reads headers. stats() forces a full pixel decode, with
    // libvips warnings treated as errors and the input pixel cap enforced.
    await sharp(bytes, options).stats();
    return Object.freeze({ verdict: "safe", pageCount: 1, frameCount: 1,
      width: metadata.width, height: metadata.height });
  } catch {
    return rejected;
  }
}
