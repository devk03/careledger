import sharp from "sharp";
import { createHash } from "node:crypto";

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
export const MAX_RENDITION_DIMENSION = 1600;
export const MAX_RENDITION_BYTES = 6 * 1024 * 1024;
export type ImageRenditionResult = Readonly<{
  verdict: "safe"; sourceSha256: string; sourceWidth: number; sourceHeight: number;
  rendition: Readonly<{ mimeType: "image/jpeg"; width: number; height: number;
    sha256: string; data: string; autoOriented: true; background: "white" }>;
}> | Readonly<{ verdict: "rejected"; code: "MALFORMED" }>;

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

/** Worker-only derivative for an AI client; it never replaces the preserved original. */
export async function renderImageInWorker(input: Uint8Array, mediaType: ImageMediaType): Promise<ImageRenditionResult> {
  if (input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES) return rejected;
  const bytes = Buffer.from(input); // Own the exact bytes before any asynchronous decode.
  const inspected = await decodeImageInWorker(bytes, mediaType);
  if (inspected.verdict !== "safe") return rejected;
  try {
    const output = await sharp(bytes, { failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS,
      limitInputChannels: 4, animated: true }).autoOrient().flatten({ background: "white" })
      .resize({ width: MAX_RENDITION_DIMENSION, height: MAX_RENDITION_DIMENSION, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
    if (output.data.length < 1 || output.data.length > MAX_RENDITION_BYTES ||
      output.info.width < 1 || output.info.height < 1 || output.info.width > MAX_RENDITION_DIMENSION ||
      output.info.height > MAX_RENDITION_DIMENSION) return rejected;
    return Object.freeze({ verdict: "safe", sourceSha256: createHash("sha256").update(bytes).digest("hex"),
      sourceWidth: inspected.width, sourceHeight: inspected.height,
      rendition: Object.freeze({ mimeType: "image/jpeg", width: output.info.width, height: output.info.height,
        sha256: createHash("sha256").update(output.data).digest("hex"), data: output.data.toString("base64"),
        autoOriented: true, background: "white" }) });
  } catch { return rejected; }
}
