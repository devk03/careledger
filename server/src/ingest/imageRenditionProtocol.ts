import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS } from "./policy.js";

export const MAX_RENDITION_DIMENSION = 1600;
export const MAX_RENDITION_BYTES = 6 * 1024 * 1024;
export const MAX_RENDITION_REPLY_BYTES = 8 * 1024 * 1024 + 2048;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z.union([
  z.strictObject({ verdict: z.literal("rejected"), code: z.literal("MALFORMED") }),
  z.strictObject({ verdict: z.literal("safe"), sourceSha256: digest,
    sourceWidth: z.number().int().min(1).max(MAX_IMAGE_DIMENSION), sourceHeight: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
    rendition: z.strictObject({ mimeType: z.literal("image/jpeg"),
      width: z.number().int().min(1).max(MAX_RENDITION_DIMENSION), height: z.number().int().min(1).max(MAX_RENDITION_DIMENSION),
      sha256: digest, data: z.string().min(4).max(8 * 1024 * 1024),
      autoOriented: z.literal(true), background: z.literal("white") }) }),
]);
export type ImageRenditionResult = z.infer<typeof schema>;
const rejected = Object.freeze({ verdict: "rejected" as const, code: "MALFORMED" as const });

/** No native image decoding in the supervisor: validate the bounded child envelope. */
export function parseImageRendition(value: unknown, expectedSourceSha256: string): ImageRenditionResult {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.verdict !== "safe") return rejected;
  const result = parsed.data; const pixels = result.sourceWidth * result.sourceHeight;
  if (result.sourceSha256 !== expectedSourceSha256 || pixels > MAX_IMAGE_PIXELS ||
    result.rendition.width * result.rendition.height > pixels) return rejected;
  const bytes = Buffer.from(result.rendition.data, "base64");
  if (bytes.length < 4 || bytes.length > MAX_RENDITION_BYTES || bytes.toString("base64") !== result.rendition.data ||
    bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217 ||
    createHash("sha256").update(bytes).digest("hex") !== result.rendition.sha256) return rejected;
  return Object.freeze({ ...result, rendition: Object.freeze(result.rendition) });
}
