import { MAX_MANAGED_VAULT_WIRE_BYTES } from "./managedVaultWireV2.js";

/** Opaque signed-index framing only. Decoding is not signature or grant verification. */
export const INDEX_HEAD_FORMAT = "adeno.index-head.v1" as const;
export const INDEX_HEAD_HEADER_BYTES = 260;
export const INDEX_HEAD_WIRE_BYTES = 324;
export const ZERO_HEAD_SHA256 = "00".repeat(32);

const MAGIC = new Uint8Array([0x41, 0x44, 0x49, 0x48]); // ADIH
const VERSION = 1;
const SUITE = 1; // Ed25519 signature; SHA-256 commitments.
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const U64_MAX = (1n << 64n) - 1n;
const CONTEXT_KEYS = ["authorCounter", "authorDeviceId", "careProfileId",
  "ciphertextByteLength", "ciphertextSha256", "grantHeadSha256", "householdId",
  "indexKeyId", "keyEpoch", "objectId", "previousHeadSha256", "sequence",
  "signingKeySha256", "viewId"];

export type IndexHeadContext = {
  householdId: string;
  careProfileId: string;
  viewId: string;
  indexKeyId: string;
  objectId: string;
  authorDeviceId: string;
  keyEpoch: number;
  sequence: bigint;
  authorCounter: bigint;
  ciphertextByteLength: number;
  previousHeadSha256: string;
  ciphertextSha256: string;
  grantHeadSha256: string;
  signingKeySha256: string;
};

export type SignedIndexHead = {
  format: typeof INDEX_HEAD_FORMAT;
  context: IndexHeadContext;
  signature: Uint8Array;
};

export class IndexHeadWireError extends Error {
  constructor() {
    super("This encrypted timeline head has an invalid storage format.");
    this.name = "IndexHeadWireError";
  }
}

/** The complete 260-byte header is the exact Ed25519 message. */
export function encodeIndexHeadHeader(context: IndexHeadContext): Uint8Array {
  assertContext(context);
  const wire = new Uint8Array(INDEX_HEAD_HEADER_BYTES);
  const view = new DataView(wire.buffer);
  wire.set(MAGIC);
  wire[4] = VERSION;
  wire[5] = SUITE;
  let offset = 8;
  for (const id of [context.householdId, context.careProfileId,
    context.viewId, context.indexKeyId, context.objectId,
    context.authorDeviceId]) {
    wire.set(fromHex(id), offset);
    offset += 16;
  }
  view.setUint32(offset, context.keyEpoch, false);
  offset += 4;
  view.setBigUint64(offset, context.sequence, false);
  offset += 8;
  view.setBigUint64(offset, context.authorCounter, false);
  offset += 8;
  view.setBigUint64(offset, BigInt(context.ciphertextByteLength), false);
  offset += 8;
  for (const digest of [context.previousHeadSha256, context.ciphertextSha256,
    context.grantHeadSha256, context.signingKeySha256]) {
    wire.set(fromHex(digest), offset);
    offset += 32;
  }
  if (offset !== INDEX_HEAD_HEADER_BYTES) throw new IndexHeadWireError();
  return wire;
}

export function encodeSignedIndexHead(head: SignedIndexHead): Uint8Array {
  if (!head || !hasOnlyKeys(head, ["context", "format", "signature"]) ||
    head.format !== INDEX_HEAD_FORMAT || !isBytes(head.signature) ||
    head.signature.byteLength !== 64) throw new IndexHeadWireError();
  const wire = new Uint8Array(INDEX_HEAD_WIRE_BYTES);
  wire.set(encodeIndexHeadHeader(head.context));
  wire.set(head.signature, INDEX_HEAD_HEADER_BYTES);
  return wire;
}

/** Exact v1 wire; all returned byte fields are independent of caller memory. */
export function decodeSignedIndexHead(input: Uint8Array): SignedIndexHead {
  if (!isBytes(input) || input.byteLength !== INDEX_HEAD_WIRE_BYTES)
    throw new IndexHeadWireError();
  const wire = Uint8Array.from(input);
  if (MAGIC.some((byte, index) => wire[index] !== byte) ||
    wire[4] !== VERSION || wire[5] !== SUITE || wire[6] !== 0 || wire[7] !== 0)
    throw new IndexHeadWireError();
  const view = new DataView(wire.buffer);
  let offset = 8;
  const field = (size: number): Uint8Array => {
    const result = wire.slice(offset, offset + size);
    offset += size;
    return result;
  };
  const [householdId, careProfileId, viewId, indexKeyId, objectId,
    authorDeviceId] = Array.from({ length: 6 }, () => hex(field(16)));
  const keyEpoch = view.getUint32(offset, false);
  offset += 4;
  const sequence = view.getBigUint64(offset, false);
  offset += 8;
  const authorCounter = view.getBigUint64(offset, false);
  offset += 8;
  const ciphertextSize = view.getBigUint64(offset, false);
  offset += 8;
  if (ciphertextSize > BigInt(MAX_MANAGED_VAULT_WIRE_BYTES))
    throw new IndexHeadWireError();
  const [previousHeadSha256, ciphertextSha256, grantHeadSha256,
    signingKeySha256] = Array.from({ length: 4 }, () => hex(field(32)));
  const signature = field(64);
  if (offset !== INDEX_HEAD_WIRE_BYTES) throw new IndexHeadWireError();
  const context: IndexHeadContext = { householdId: householdId!,
    careProfileId: careProfileId!, viewId: viewId!, indexKeyId: indexKeyId!,
    objectId: objectId!, authorDeviceId: authorDeviceId!, keyEpoch,
    sequence, authorCounter, ciphertextByteLength: Number(ciphertextSize),
    previousHeadSha256: previousHeadSha256!, ciphertextSha256: ciphertextSha256!,
    grantHeadSha256: grantHeadSha256!, signingKeySha256: signingKeySha256! };
  assertContext(context);
  return { format: INDEX_HEAD_FORMAT, context, signature };
}

function assertContext(context: IndexHeadContext): void {
  if (!context || !hasOnlyKeys(context, CONTEXT_KEYS) ||
    ![context.householdId, context.careProfileId, context.viewId,
      context.indexKeyId, context.objectId, context.authorDeviceId]
      .every((id) => typeof id === "string" && OPAQUE_ID.test(id)) ||
    !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1 ||
    context.keyEpoch > 0xffffffff ||
    typeof context.sequence !== "bigint" || context.sequence < 1n ||
    context.sequence > U64_MAX ||
    typeof context.authorCounter !== "bigint" || context.authorCounter < 1n ||
    context.authorCounter > U64_MAX ||
    !Number.isSafeInteger(context.ciphertextByteLength) ||
    context.ciphertextByteLength < 65 ||
    context.ciphertextByteLength > MAX_MANAGED_VAULT_WIRE_BYTES ||
    ![context.previousHeadSha256, context.ciphertextSha256,
      context.grantHeadSha256, context.signingKeySha256]
      .every((digest) => typeof digest === "string" && SHA256.test(digest)) ||
    (context.sequence === 1n) !==
      (context.previousHeadSha256 === ZERO_HEAD_SHA256))
    throw new IndexHeadWireError();
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function hex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
