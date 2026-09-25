import { randomUUID } from "node:crypto";
import { z } from "zod";

import { MAX_UPLOAD_BYTES, type AdmittedMediaType } from "./admission.js";
import { INGEST_POLICY_VERSION, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS,
  MAX_PDF_OBJECTS, MAX_PDF_PAGE_POINTS, MAX_PDF_PAGES } from "./policy.js";

export const MAX_PARSER_HEADER_BYTES = 512;
export const MAX_PARSER_REPLY_BYTES = 2048;
export const PARSER_WORKER_VERSION = "adeno-parser-1";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const common = {
  protocolVersion: z.literal(1),
  requestId: z.uuid(),
  policyVersion: z.literal(INGEST_POLICY_VERSION),
  sha256: digest,
  byteSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  mediaType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
};
const requestSchema = z.strictObject(common);
const replyCommon = { ...common, workerVersion: z.literal(PARSER_WORKER_VERSION) };
const pdfSafeSchema = z.strictObject({
  ...replyCommon, mediaType: z.literal("application/pdf"), verdict: z.literal("safe"),
  pageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  objectCount: z.number().int().min(1).max(MAX_PDF_OBJECTS),
  maxPageWidthPoints: z.number().finite().positive().max(MAX_PDF_PAGE_POINTS),
  maxPageHeightPoints: z.number().finite().positive().max(MAX_PDF_PAGE_POINTS),
  encrypted: z.literal(false), activeContent: z.literal(false),
});
const imageSafeSchema = z.strictObject({
  ...replyCommon, mediaType: z.enum(["image/jpeg", "image/png"]),
  verdict: z.literal("safe"), pageCount: z.literal(1), frameCount: z.literal(1),
  width: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
  height: z.number().int().min(1).max(MAX_IMAGE_DIMENSION),
});
const rejectedSchema = z.strictObject({
  ...replyCommon, verdict: z.literal("rejected"),
  code: z.enum(["MALFORMED", "ENCRYPTED", "ACTIVE_CONTENT", "LIMIT_EXCEEDED",
    "ANIMATED", "UNSUPPORTED"]),
});
const replySchema = z.union([pdfSafeSchema, imageSafeSchema, rejectedSchema]);

export type ParserRequest = z.infer<typeof requestSchema>;
export type ParserReply = z.infer<typeof replySchema>;

export class ParserProtocolError extends Error {
  constructor() { super("PARSER_PROTOCOL_ERROR"); }
}

function parseJson(bytes: Uint8Array, maximum: number): unknown {
  if (bytes.byteLength < 2 || bytes.byteLength > maximum) throw new ParserProtocolError();
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new ParserProtocolError(); }
}

export function createParserRequest(input: {
  mediaType: AdmittedMediaType; sha256: string; byteSize: number;
}): ParserRequest {
  const parsed = requestSchema.safeParse({
    ...input,
    protocolVersion: 1, requestId: randomUUID(), policyVersion: INGEST_POLICY_VERSION,
  });
  if (!parsed.success) throw new ParserProtocolError();
  return Object.freeze(parsed.data);
}

/** Four-byte big-endian header length, followed by bounded UTF-8 JSON. */
export function encodeParserRequestHeader(request: ParserRequest): Buffer {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) throw new ParserProtocolError();
  const json = Buffer.from(JSON.stringify(parsed.data), "utf8");
  if (json.length > MAX_PARSER_HEADER_BYTES) throw new ParserProtocolError();
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

/** Parses only the JSON body after the transport has bounded its frame. */
export function parseParserRequestHeader(bytes: Uint8Array): ParserRequest {
  const parsed = requestSchema.safeParse(parseJson(bytes, MAX_PARSER_HEADER_BYTES));
  if (!parsed.success) throw new ParserProtocolError();
  return parsed.data;
}

/** Rejects unknown fields and replies not bound to the exact request. */
export function parseParserReply(bytes: Uint8Array, expected: ParserRequest): ParserReply {
  const expectedResult = requestSchema.safeParse(expected);
  const parsed = replySchema.safeParse(parseJson(bytes, MAX_PARSER_REPLY_BYTES));
  if (!expectedResult.success || !parsed.success) throw new ParserProtocolError();
  for (const key of ["protocolVersion", "requestId", "policyVersion", "sha256",
    "byteSize", "mediaType"] as const) {
    if (parsed.data[key] !== expectedResult.data[key]) throw new ParserProtocolError();
  }
  if (parsed.data.verdict === "safe" && parsed.data.mediaType !== "application/pdf" &&
    parsed.data.width * parsed.data.height > MAX_IMAGE_PIXELS) throw new ParserProtocolError();
  return parsed.data;
}
