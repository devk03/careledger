import { createHash } from "node:crypto";

export type AdmittedMediaType = "application/pdf" | "image/jpeg" | "image/png";
export type AdmissionErrorCode =
  | "EMPTY_UPLOAD"
  | "UPLOAD_TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "MIME_MISMATCH"
  | "EXTENSION_MISMATCH";

export class UploadAdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) {
    super(code);
  }
}

export type AdmissionMetadata = {
  displayName: string;
  mediaType: AdmittedMediaType;
  byteSize: number;
  sha256: string;
  receivedAt: string;
};

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PUNCTUATION = new Set(["-", "_", ".", "(", ")", "[", "]"]);
const EXTENSIONS: Record<AdmittedMediaType, readonly string[]> = {
  "application/pdf": [".pdf"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
};
const CANONICAL_EXTENSION: Record<AdmittedMediaType, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};
const RESERVED_STEMS = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

function detectedMediaType(bytes: Uint8Array): AdmittedMediaType {
  if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 8 && PNG_SIGNATURE.equals(Buffer.from(bytes.subarray(0, 8)))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  throw new UploadAdmissionError("UNSUPPORTED_TYPE");
}

function validatedClaimedMediaType(claimed: string | undefined, detected: AdmittedMediaType): void {
  const normalized = claimed?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized || normalized === "application/octet-stream") return;
  const alias = normalized === "image/jpg" ? "image/jpeg" : normalized;
  if (alias !== detected) throw new UploadAdmissionError("MIME_MISMATCH");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let result = "";
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function safeDisplayName(rawName: string, mediaType: AdmittedMediaType): string {
  const basename = rawName.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const normalized = basename.normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/^[ .]+|[ .]+$/g, "");
  const cleaned = [...normalized].map((character) =>
    /[\p{L}\p{N}]/u.test(character) || /\s/u.test(character) || PUNCTUATION.has(character)
      ? character : "-",
  ).join("").replace(/-+/g, "-").replace(/^[ .-]+|[ .-]+$/g, "");

  const dot = cleaned.lastIndexOf(".");
  const suppliedExtension = dot >= 0 ? cleaned.slice(dot).toLowerCase() : "";
  let stem = dot >= 0 ? cleaned.slice(0, dot) : cleaned;
  if (suppliedExtension && !EXTENSIONS[mediaType].includes(suppliedExtension)) {
    throw new UploadAdmissionError("EXTENSION_MISMATCH");
  }
  stem = stem.replace(/^[ .-]+|[ .-]+$/g, "");
  if (!stem || RESERVED_STEMS.has(stem.toUpperCase())) stem = "health-record";

  const extension = CANONICAL_EXTENSION[mediaType];
  const budget = 120 - Buffer.byteLength(extension, "utf8");
  const shortened = truncateUtf8(stem, budget).replace(/[ .-]+$/g, "") || "health-record";
  return `${shortened}${extension}`;
}

/**
 * Preliminary admission only. This does not parse, scan, store or mark a file
 * safe to render. Promotion must still pass isolated inspection and malware policy.
 */
export function inspectUploadBytes(
  bytes: Uint8Array,
  input: {
    originalName: string;
    claimedMediaType?: string;
    maxBytes?: number;
    receivedAt?: Date;
  },
): AdmissionMetadata {
  const maxBytes = input.maxBytes ?? MAX_UPLOAD_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_UPLOAD_BYTES) {
    throw new RangeError("Invalid upload byte limit");
  }
  if (bytes.byteLength === 0) throw new UploadAdmissionError("EMPTY_UPLOAD");
  if (bytes.byteLength > maxBytes) throw new UploadAdmissionError("UPLOAD_TOO_LARGE");

  const mediaType = detectedMediaType(bytes);
  validatedClaimedMediaType(input.claimedMediaType, mediaType);
  const displayName = safeDisplayName(input.originalName, mediaType);
  const receivedAt = input.receivedAt ?? new Date();
  if (Number.isNaN(receivedAt.getTime())) throw new RangeError("Invalid received-at time");

  return {
    displayName,
    mediaType,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    receivedAt: receivedAt.toISOString(),
  };
}
