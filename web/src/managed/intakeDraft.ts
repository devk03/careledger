import { decodeManagedVaultBlobV2, encodeManagedVaultBlobV2,
  MANAGED_VAULT_CHUNK_BYTES } from "@adeno/contracts";

import { decryptManagedVaultBlobV2, encryptManagedVaultBlobV2,
  type ManagedVaultScopeV2 } from
  "../crypto/managedVaultV2";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_METADATA_WIRE_BYTES = 32 * 1024;
// Opening v2 currently holds several authenticated copies in browser memory.
// Raise this only with a streaming reader and mobile-browser memory evidence.
export const MAX_LOCAL_DRAFT_BYTES = 16 * MANAGED_VAULT_CHUNK_BYTES;
const MAX_LOCAL_DRAFT_WIRE_BYTES = 33 + MAX_LOCAL_DRAFT_BYTES +
  16 * (12 + 4 + 16);

export type LocalDraftIdentity = {
  householdId: string;
  careProfileId: string;
  opaqueDraftId: string;
  keyEpoch: number;
};

export type LocalFile = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type LocalDraftInput = {
  identity: LocalDraftIdentity;
  key: CryptoKey;
  /** Two server-reserved IDs obtained before encryption; never infer from a URL. */
  reservedBlobIds: { content: string; metadata: string };
  clientSelectedAt: string;
  candidateCareDays: readonly string[];
} & (
  | { kind: "file"; file: LocalFile }
  | { kind: "family_note"; body: string; authorLabel: string }
);

/** Only opaque identifiers and encrypted bytes; this is not an uploaded/saved record. */
export type LocalEncryptedDraft = {
  opaqueDraftId: string;
  contentObjectId: string;
  metadataObjectId: string;
  contentBlobId: string;
  metadataBlobId: string;
  contentWire: Uint8Array;
  metadataWire: Uint8Array;
};

/** Device-only, still pending human review. This is not a published day. */
export type LocalOpenedDraft = {
  opaqueDraftId: string;
  clientSelectedAt: string;
  candidateCareDays: string[];
  sourceSha256: string;
  byteSize: number;
} & (
  | { kind: "file"; originalName: string;
      mediaType: "application/pdf" | "image/png" | "image/jpeg";
      content: Uint8Array }
  | { kind: "family_note"; authorLabel: string; body: string }
);

export class InvalidLocalDraft extends Error {
  constructor() { super("This local record draft is invalid or too large."); }
}

/**
 * On-device preparation only. No network, server timestamp, grant, durable
 * nonce reservation, recovery envelope, scan, OCR, or PDF rendering happens here.
 * The caller must supply a distinct review-draft key, never an approved day key.
 */
export async function prepareLocalEncryptedDraft(input: LocalDraftInput):
  Promise<LocalEncryptedDraft> {
  const stable = snapshotInput(input);
  let content: Uint8Array | null = null;
  let mediaType: string;
  try {
    if (stable.kind === "file") {
      const buffer = await stable.file.arrayBuffer();
      if (buffer.byteLength !== stable.file.size || buffer.byteLength < 1 ||
        buffer.byteLength > MAX_LOCAL_DRAFT_BYTES) throw new InvalidLocalDraft();
      content = Uint8Array.from(new Uint8Array(buffer));
      mediaType = sniffMediaType(content);
    } else {
      content = new TextEncoder().encode(stable.body);
      mediaType = "text/plain; charset=utf-8";
    }
    const contentObjectId = randomOpaqueId();
    const metadataObjectId = randomOpaqueId();
    const contentScope = draftScope(stable.identity, contentObjectId);
    const metadataScope = draftScope(stable.identity, metadataObjectId);
    const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));
    const encryptedContent = await encryptManagedVaultBlobV2(stable.key,
      content, contentScope, fromHex(stable.reservedBlobIds.content));
    const metadata = stable.kind === "file" ? {
      format: "adeno.local-review-draft.v1", kind: "file",
      clientSelectedAt: stable.clientSelectedAt,
      candidateCareDays: stable.candidateCareDays,
      originalName: stable.file.name, mediaType,
      contentBlobId: hex(encryptedContent.blobId),
      sourceSha256: digest, byteSize: content.byteLength,
    } : {
      format: "adeno.local-review-draft.v1", kind: "family_note",
      clientSelectedAt: stable.clientSelectedAt,
      candidateCareDays: stable.candidateCareDays,
      authorLabel: stable.authorLabel, mediaType,
      contentBlobId: hex(encryptedContent.blobId),
      sourceSha256: digest, byteSize: content.byteLength,
    };
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
    try {
      const encryptedMetadata = await encryptManagedVaultBlobV2(stable.key,
        metadataBytes, metadataScope, fromHex(stable.reservedBlobIds.metadata));
      return { opaqueDraftId: stable.identity.opaqueDraftId,
        contentObjectId, metadataObjectId,
        contentBlobId: hex(encryptedContent.blobId),
        metadataBlobId: hex(encryptedMetadata.blobId),
        contentWire: encodeManagedVaultBlobV2(encryptedContent),
        metadataWire: encodeManagedVaultBlobV2(encryptedMetadata) };
    } finally { metadataBytes.fill(0); }
  } finally { content?.fill(0); }
}

/**
 * Open a pending draft on a keyholding device. Both wires must
 * authenticate under the same draft scope, and metadata must describe the
 * exact original bytes. The caller owns and must clear a returned file buffer.
 * The caller must separately check current session/device/grant, revocation,
 * receipt and freshness before any persisted read or UI exposure. This does
 * not inspect PDFs for active content or approve/publicize a day.
 */
export async function openLocalEncryptedDraft(input: {
  identity: LocalDraftIdentity;
  key: CryptoKey;
  draft: LocalEncryptedDraft;
}): Promise<LocalOpenedDraft> {
  let metadataBytes: Uint8Array | null = null;
  let content: Uint8Array | null = null;
  try {
    const identity = { ...input.identity };
    const draft = snapshotEncryptedDraft(input.draft, identity);
    const metadataBlob = decodeManagedVaultBlobV2(draft.metadataWire);
    if (hex(metadataBlob.blobId) !== draft.metadataBlobId)
      throw new InvalidLocalDraft();
    metadataBytes = await decryptManagedVaultBlobV2(input.key, metadataBlob,
      draftScope(identity, draft.metadataObjectId));
    const metadata = parseDraftMetadata(metadataBytes, draft.contentBlobId);
    const contentBlob = decodeManagedVaultBlobV2(draft.contentWire);
    if (hex(contentBlob.blobId) !== draft.contentBlobId)
      throw new InvalidLocalDraft();
    if (contentBlob.plaintextSize > MAX_LOCAL_DRAFT_BYTES)
      throw new InvalidLocalDraft();
    content = await decryptManagedVaultBlobV2(input.key, contentBlob,
      draftScope(identity, draft.contentObjectId));
    if (content.byteLength !== metadata.byteSize ||
      hex(new Uint8Array(await crypto.subtle.digest("SHA-256", content))) !==
        metadata.sourceSha256) throw new InvalidLocalDraft();
    const common = { opaqueDraftId: identity.opaqueDraftId,
      clientSelectedAt: metadata.clientSelectedAt,
      candidateCareDays: [...metadata.candidateCareDays],
      sourceSha256: metadata.sourceSha256, byteSize: metadata.byteSize };
    if (metadata.kind === "file") {
      if (sniffMediaType(content) !== metadata.mediaType)
        throw new InvalidLocalDraft();
      const opened: LocalOpenedDraft = { ...common, kind: "file",
        originalName: metadata.originalName, mediaType: metadata.mediaType,
        content };
      content = null; // ownership passes to the caller
      return opened;
    }
    if (metadata.mediaType !== "text/plain; charset=utf-8")
      throw new InvalidLocalDraft();
    const body = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!visibleText(body, 20_000, true)) throw new InvalidLocalDraft();
    return { ...common, kind: "family_note", authorLabel: metadata.authorLabel,
      body };
  } catch { throw new InvalidLocalDraft(); }
  finally { metadataBytes?.fill(0); content?.fill(0); }
}

type ParsedDraftMetadata = {
  clientSelectedAt: string; candidateCareDays: string[];
  contentBlobId: string; sourceSha256: string; byteSize: number;
} & (
  | { kind: "file"; originalName: string;
      mediaType: "application/pdf" | "image/png" | "image/jpeg" }
  | { kind: "family_note"; authorLabel: string;
      mediaType: "text/plain; charset=utf-8" }
);

function snapshotEncryptedDraft(draft: LocalEncryptedDraft,
  identity: LocalDraftIdentity): LocalEncryptedDraft {
  if (!identity || ![identity.householdId, identity.careProfileId,
    identity.opaqueDraftId].every((id) => typeof id === "string" &&
      OPAQUE_ID.test(id)) || !Number.isSafeInteger(identity.keyEpoch) ||
    identity.keyEpoch < 1 || identity.keyEpoch > 0xffffffff ||
    !draft || draft.opaqueDraftId !== identity.opaqueDraftId ||
    ![draft.contentObjectId, draft.metadataObjectId, draft.contentBlobId,
      draft.metadataBlobId].every((id) => typeof id === "string" &&
      OPAQUE_ID.test(id)) ||
    draft.contentObjectId === draft.metadataObjectId ||
    draft.contentBlobId === draft.metadataBlobId ||
    !validWire(draft.contentWire, MAX_LOCAL_DRAFT_WIRE_BYTES) ||
    !validWire(draft.metadataWire, MAX_METADATA_WIRE_BYTES))
    throw new InvalidLocalDraft();
  return { opaqueDraftId: draft.opaqueDraftId,
    contentObjectId: draft.contentObjectId,
    metadataObjectId: draft.metadataObjectId,
    contentBlobId: draft.contentBlobId,
    metadataBlobId: draft.metadataBlobId,
    contentWire: Uint8Array.from(draft.contentWire),
    metadataWire: Uint8Array.from(draft.metadataWire) };
}

function validWire(value: Uint8Array, maximum: number): boolean {
  return Object.prototype.toString.call(value) === "[object Uint8Array]" &&
    value.byteLength >= 65 && value.byteLength <= maximum;
}

function parseDraftMetadata(bytes: Uint8Array,
  expectedContentBlobId: string): ParsedDraftMetadata {
  if (bytes.byteLength > 16 * 1024) throw new InvalidLocalDraft();
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
    .decode(bytes));
  if (!plainRecord(value) ||
    value.format !== "adeno.local-review-draft.v1" ||
    !validTimestamp(value.clientSelectedAt) ||
    !Array.isArray(value.candidateCareDays) ||
    value.candidateCareDays.length > 366 ||
    !value.candidateCareDays.every(validDay) ||
    new Set(value.candidateCareDays).size !== value.candidateCareDays.length ||
    value.contentBlobId !== expectedContentBlobId ||
    typeof value.sourceSha256 !== "string" ||
    !SHA256.test(value.sourceSha256) ||
    !validByteSize(value.byteSize))
    throw new InvalidLocalDraft();
  const common = { clientSelectedAt: value.clientSelectedAt,
    candidateCareDays: [...value.candidateCareDays],
    contentBlobId: value.contentBlobId,
    sourceSha256: value.sourceSha256, byteSize: value.byteSize };
  if (value.kind === "file" &&
    exactKeys(value, ["format", "kind", "clientSelectedAt",
      "candidateCareDays", "originalName", "mediaType", "contentBlobId",
      "sourceSha256", "byteSize"]) &&
    visibleText(value.originalName, 256, false) &&
    ["application/pdf", "image/png", "image/jpeg"].includes(
      value.mediaType as string))
    return { ...common, kind: "file", originalName: value.originalName,
      mediaType: value.mediaType as "application/pdf" | "image/png" | "image/jpeg" };
  if (value.kind === "family_note" &&
    exactKeys(value, ["format", "kind", "clientSelectedAt",
      "candidateCareDays", "authorLabel", "mediaType", "contentBlobId",
      "sourceSha256", "byteSize"]) &&
    visibleText(value.authorLabel, 256, false) &&
    value.mediaType === "text/plain; charset=utf-8")
    return { ...common, kind: "family_note", authorLabel: value.authorLabel,
      mediaType: "text/plain; charset=utf-8" };
  throw new InvalidLocalDraft();
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}

function validByteSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1 && value <= MAX_LOCAL_DRAFT_BYTES;
}

function snapshotInput(input: LocalDraftInput): LocalDraftInput {
  validateInput(input);
  const common = { identity: { ...input.identity }, key: input.key,
    reservedBlobIds: { ...input.reservedBlobIds },
    clientSelectedAt: input.clientSelectedAt,
    candidateCareDays: [...input.candidateCareDays] };
  const stable: LocalDraftInput = input.kind === "file" ? (() => {
    const source = input.file;
    const read = source.arrayBuffer.bind(source);
    return { ...common, kind: "file", file: { name: source.name,
      size: source.size, arrayBuffer: read } };
  })() : { ...common, kind: "family_note", body: input.body,
    authorLabel: input.authorLabel };
  validateInput(stable);
  return stable;
}

function validateInput(input: LocalDraftInput): void {
  if (!input || !input.identity || !input.reservedBlobIds ||
    ![input.identity.householdId, input.identity.careProfileId,
      input.identity.opaqueDraftId].every((id) =>
      typeof id === "string" && OPAQUE_ID.test(id)) ||
    !Number.isSafeInteger(input.identity.keyEpoch) ||
    input.identity.keyEpoch < 1 || input.identity.keyEpoch > 0xffffffff ||
    typeof input.reservedBlobIds.content !== "string" ||
    !OPAQUE_ID.test(input.reservedBlobIds.content) ||
    typeof input.reservedBlobIds.metadata !== "string" ||
    !OPAQUE_ID.test(input.reservedBlobIds.metadata) ||
    input.reservedBlobIds.content === input.reservedBlobIds.metadata ||
    !validTimestamp(input.clientSelectedAt) ||
    !Array.isArray(input.candidateCareDays) ||
    input.candidateCareDays.length > 366 ||
    new Set(input.candidateCareDays).size !== input.candidateCareDays.length ||
    !input.candidateCareDays.every(validDay)) throw new InvalidLocalDraft();
  if (input.kind === "file") {
    if (!input.file || !visibleText(input.file.name, 256, false) ||
      !Number.isSafeInteger(input.file.size) || input.file.size < 1 ||
    input.file.size > MAX_LOCAL_DRAFT_BYTES ||
      typeof input.file.arrayBuffer !== "function") throw new InvalidLocalDraft();
  } else if (input.kind === "family_note") {
    if (!visibleText(input.body, 20_000, true) ||
      !visibleText(input.authorLabel, 256, false)) throw new InvalidLocalDraft();
  } else throw new InvalidLocalDraft();
}

function draftScope(identity: LocalDraftIdentity, objectId: string): ManagedVaultScopeV2 {
  return { householdId: identity.householdId,
    careProfileId: identity.careProfileId,
    opaqueScopeId: identity.opaqueDraftId, objectId,
    keyEpoch: identity.keyEpoch, purpose: "review-draft", revision: 1 };
}

function sniffMediaType(bytes: Uint8Array): string {
  if (bytes.byteLength >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d)
    return "application/pdf";
  if (bytes.byteLength >= 8 && PNG.every((byte, index) => bytes[index] === byte))
    return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff) return "image/jpeg";
  throw new InvalidLocalDraft();
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function visibleText(value: unknown, maximum: number,
  multiline: boolean): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximum && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 8 || code === 11 || code === 12 ||
        (!multiline && (code === 10 || code === 13)) ||
        (code >= 14 && code <= 31) || code === 127;
    });
}

function randomOpaqueId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
