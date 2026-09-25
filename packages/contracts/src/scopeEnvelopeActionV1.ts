import type { ScopeKeyPurposeV2 } from "./scopeKeyEnvelopeWireV2.js";

/** Exact Ed25519 message for issuing one v2 scope-key envelope. */
export const SCOPE_ENVELOPE_ACTION_PAYLOAD_BYTES_V1 = 368;
export const SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1 =
  "adeno:managed:scope-envelope-action-hash:v1\0";

const MAGIC = new Uint8Array([0x41, 0x44, 0x53, 0x45]); // ADSE.
const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SQLITE_MAX = (1n << 63n) - 1n;
const KEYS = ["activeKeyHeadSha256", "careProfileId", "createdAt",
  "grantHeadSha256", "householdId", "issuerCounter", "issuerDeviceId",
  "issuerSigningKeySha256", "keyCommitmentSha256", "keyEpoch", "keyId",
  "opaqueScopeId", "previousActionSha256", "purpose", "recipientDeviceId",
  "recipientKeySha256", "sessionId", "wireSha256"];

export type ScopeEnvelopeActionContextV1 = {
  householdId: string;
  careProfileId: string;
  opaqueScopeId: string;
  keyId: string;
  keyEpoch: number;
  purpose: ScopeKeyPurposeV2;
  recipientDeviceId: string;
  keyCommitmentSha256: string;
  recipientKeySha256: string;
  wireSha256: string;
  activeKeyHeadSha256: string;
  grantHeadSha256: string;
  issuerDeviceId: string;
  issuerCounter: bigint;
  sessionId: string;
  createdAt: bigint;
  previousActionSha256: string | null;
  issuerSigningKeySha256: string;
};

export class ScopeEnvelopeActionV1Error extends Error {
  constructor() {
    super("This signed scope-key action has an invalid format.");
    this.name = "ScopeEnvelopeActionV1Error";
  }
}

/** Fixed-width, domain-separated and unambiguous; never sign JSON serialization. */
export function encodeScopeEnvelopeActionPayloadV1(
  context: ScopeEnvelopeActionContextV1,
): Uint8Array {
  if (!context || !onlyKeys(context, KEYS) ||
    ![context.householdId, context.careProfileId, context.opaqueScopeId,
      context.keyId, context.recipientDeviceId, context.issuerDeviceId,
      context.sessionId].every((value) => typeof value === "string" && ID.test(value)) ||
    ![context.keyCommitmentSha256, context.recipientKeySha256,
      context.wireSha256, context.activeKeyHeadSha256,
      context.grantHeadSha256, context.issuerSigningKeySha256]
      .every((value) => typeof value === "string" && HASH.test(value)) ||
    (context.previousActionSha256 !== null &&
      (typeof context.previousActionSha256 !== "string" ||
        !HASH.test(context.previousActionSha256))) ||
    !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1 ||
    context.keyEpoch > 0xffffffff ||
    typeof context.issuerCounter !== "bigint" || context.issuerCounter < 1n ||
    context.issuerCounter > SQLITE_MAX ||
    typeof context.createdAt !== "bigint" || context.createdAt < 1n ||
    context.createdAt > SQLITE_MAX ||
    (context.issuerCounter === 1n) !== (context.previousActionSha256 === null))
    throw new ScopeEnvelopeActionV1Error();

  const purpose = purposeByte(context.purpose);
  const bytes = new Uint8Array(SCOPE_ENVELOPE_ACTION_PAYLOAD_BYTES_V1);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC);
  bytes[4] = 1; // Format version.
  bytes[5] = 1; // Ed25519 + SHA-256.
  bytes[6] = 1; // Issue v2 scope-key envelope, not another action kind.
  bytes[7] = context.previousActionSha256 === null ? 0 : 1;
  let offset = 8;
  for (const id of [context.householdId, context.careProfileId,
    context.opaqueScopeId, context.keyId, context.recipientDeviceId,
    context.issuerDeviceId, context.sessionId]) {
    bytes.set(fromHex(id), offset);
    offset += 16;
  }
  view.setUint32(offset, context.keyEpoch, false);
  offset += 4;
  bytes[offset] = purpose;
  offset += 4; // Three reserved zero bytes.
  view.setBigUint64(offset, context.issuerCounter, false);
  offset += 8;
  view.setBigUint64(offset, context.createdAt, false);
  offset += 8;
  for (const digest of [context.keyCommitmentSha256,
    context.recipientKeySha256, context.wireSha256,
    context.activeKeyHeadSha256, context.grantHeadSha256,
    context.previousActionSha256 ?? "00".repeat(32),
    context.issuerSigningKeySha256]) {
    bytes.set(fromHex(digest), offset);
    offset += 32;
  }
  if (offset !== bytes.byteLength) throw new ScopeEnvelopeActionV1Error();
  return bytes;
}

function purposeByte(purpose: ScopeKeyPurposeV2): number {
  if (purpose === "day") return 1;
  if (purpose === "source") return 2;
  if (purpose === "draft") return 3;
  if (purpose === "index") return 4;
  throw new ScopeEnvelopeActionV1Error();
}

function onlyKeys(value: object, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function fromHex(value: string): Uint8Array {
  const output = new Uint8Array(value.length / 2);
  for (let i = 0; i < output.length; i++)
    output[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return output;
}
