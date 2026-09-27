/** Exact Ed25519 message for submitting two ciphertext blobs for review. */
export const PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1 = 480;
export const PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1 =
  "adeno:managed:pending-draft-pair-action-hash:v1\0";

const MAGIC = new Uint8Array([0x41, 0x44, 0x50, 0x50]); // ADPP.
const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SQLITE_MAX = (1n << 63n) - 1n;
const MAX_CONTENT_WIRE_BYTES = 33 + 16 * 1024 * 1024 + 32 * 16;
const MAX_METADATA_WIRE_BYTES = 32 * 1024;
const KEYS = ["activeKeyHeadSha256", "authorCounter", "authorDeviceId",
  "careProfileId", "contentBlobId", "contentIntentId", "contentObjectId",
  "contentWireBytes", "contentWireSha256", "grantHeadSha256", "householdId",
  "issuerSigningKeySha256", "keyCommitmentSha256", "keyEpoch", "keyId",
  "metadataBlobId", "metadataIntentId", "metadataObjectId",
  "metadataWireBytes", "metadataWireSha256", "opaqueDraftScopeId",
  "pairedAt", "previousActionSha256", "reservationId", "sessionId"];

export type PendingDraftPairActionContextV1 = {
  householdId: string;
  careProfileId: string;
  opaqueDraftScopeId: string;
  keyId: string;
  reservationId: string;
  contentIntentId: string;
  metadataIntentId: string;
  contentBlobId: string;
  metadataBlobId: string;
  contentObjectId: string;
  metadataObjectId: string;
  authorDeviceId: string;
  sessionId: string;
  keyEpoch: number;
  authorCounter: bigint;
  pairedAt: bigint;
  contentWireBytes: number;
  metadataWireBytes: number;
  keyCommitmentSha256: string;
  activeKeyHeadSha256: string;
  grantHeadSha256: string;
  contentWireSha256: string;
  metadataWireSha256: string;
  previousActionSha256: string | null;
  issuerSigningKeySha256: string;
};

export class PendingDraftPairActionV1Error extends Error {
  constructor() {
    super("This pending draft-pair action has an invalid format.");
    this.name = "PendingDraftPairActionV1Error";
  }
}

/** Fixed-width, domain-separated submission, not adult approval. */
export function encodePendingDraftPairActionPayloadV1(
  context: PendingDraftPairActionContextV1,
): Uint8Array {
  if (!context || Object.getPrototypeOf(context) !== Object.prototype ||
    !onlyKeys(context, KEYS) ||
    ![context.householdId, context.careProfileId,
      context.opaqueDraftScopeId, context.keyId, context.reservationId,
      context.contentIntentId, context.metadataIntentId,
      context.contentBlobId, context.metadataBlobId,
      context.contentObjectId, context.metadataObjectId,
      context.authorDeviceId, context.sessionId]
      .every((value) => typeof value === "string" && ID.test(value)) ||
    context.contentIntentId === context.metadataIntentId ||
    context.contentBlobId === context.metadataBlobId ||
    context.contentObjectId === context.metadataObjectId ||
    ![context.keyCommitmentSha256, context.activeKeyHeadSha256,
      context.grantHeadSha256, context.contentWireSha256,
      context.metadataWireSha256, context.issuerSigningKeySha256]
      .every((value) => typeof value === "string" && HASH.test(value)) ||
    (context.previousActionSha256 !== null &&
      (typeof context.previousActionSha256 !== "string" ||
        !HASH.test(context.previousActionSha256))) ||
    !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1 ||
    context.keyEpoch > 0xffffffff ||
    !validWireBytes(context.contentWireBytes, MAX_CONTENT_WIRE_BYTES) ||
    !validWireBytes(context.metadataWireBytes, MAX_METADATA_WIRE_BYTES) ||
    typeof context.authorCounter !== "bigint" ||
    context.authorCounter < 1n || context.authorCounter > SQLITE_MAX ||
    typeof context.pairedAt !== "bigint" ||
    context.pairedAt < 1n || context.pairedAt > SQLITE_MAX ||
    (context.authorCounter === 1n) !==
      (context.previousActionSha256 === null))
    throw new PendingDraftPairActionV1Error();

  const bytes = new Uint8Array(PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC);
  bytes[4] = 1; // Format version.
  bytes[5] = 1; // Ed25519 + SHA-256.
  bytes[6] = 1; // Register pending pair; never an approval action.
  bytes[7] = context.previousActionSha256 === null ? 0 : 1;
  let offset = 8;
  for (const id of [context.householdId, context.careProfileId,
    context.opaqueDraftScopeId, context.keyId, context.reservationId,
    context.contentIntentId, context.metadataIntentId,
    context.contentBlobId, context.metadataBlobId,
    context.contentObjectId, context.metadataObjectId,
    context.authorDeviceId, context.sessionId]) {
    bytes.set(fromHex(id), offset);
    offset += 16;
  }
  view.setUint32(offset, context.keyEpoch, false);
  offset += 4;
  bytes[offset] = 3; // Draft-key purpose, plus three reserved zero bytes.
  offset += 4;
  view.setBigUint64(offset, context.authorCounter, false);
  offset += 8;
  view.setBigUint64(offset, context.pairedAt, false);
  offset += 8;
  view.setBigUint64(offset, BigInt(context.contentWireBytes), false);
  offset += 8;
  view.setBigUint64(offset, BigInt(context.metadataWireBytes), false);
  offset += 8;
  for (const digest of [context.keyCommitmentSha256,
    context.activeKeyHeadSha256, context.grantHeadSha256,
    context.contentWireSha256, context.metadataWireSha256,
    context.previousActionSha256 ?? "00".repeat(32),
    context.issuerSigningKeySha256]) {
    bytes.set(fromHex(digest), offset);
    offset += 32;
  }
  if (offset !== bytes.byteLength) throw new PendingDraftPairActionV1Error();
  return bytes;
}

function validWireBytes(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 65 &&
    (value as number) <= maximum;
}

function onlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index]);
}

function fromHex(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < output.length; index++)
    output[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}
