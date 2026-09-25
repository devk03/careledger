import { encodeScopeEnvelopeActionPayloadV1,
  type ScopeEnvelopeActionContextV1 } from "./scopeEnvelopeActionV1.js";

/** Explicit owner-approved historical rewrap; never valid as ordinary issuance. */
export const SCOPE_ENVELOPE_BACKFILL_PAYLOAD_BYTES_V1 = 424;
export const SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1 =
  "adeno:managed:scope-envelope-backfill-action-hash:v1\0";

const MAGIC = new Uint8Array([0x41, 0x44, 0x48, 0x42]); // ADHB.
const HASH = /^[0-9a-f]{64}$/u;
const SQLITE_MAX = (1n << 63n) - 1n;
const KEYS = ["activeKeyHeadSha256", "careProfileId", "createdAt",
  "currentActiveKeySequence", "currentGrantSequence", "grantHeadSha256",
  "historicalActivationSequence", "historicalActivationSha256", "householdId",
  "issuerCounter", "issuerDeviceId", "issuerSigningKeySha256",
  "keyCommitmentSha256", "keyEpoch", "keyId", "opaqueScopeId",
  "previousActionSha256", "purpose", "recipientDeviceId",
  "recipientKeySha256", "sessionId", "wireSha256"];

export type ScopeEnvelopeBackfillActionContextV1 =
  ScopeEnvelopeActionContextV1 & {
    historicalActivationSequence: bigint;
    historicalActivationSha256: string;
    currentActiveKeySequence: bigint;
    currentGrantSequence: bigint;
  };

export class ScopeEnvelopeBackfillActionV1Error extends Error {
  constructor() {
    super("This historical scope-key action has an invalid format.");
    this.name = "ScopeEnvelopeBackfillActionV1Error";
  }
}

/** Fixed-width distinct operation; the first 368 bytes cannot verify as ADSE. */
export function encodeScopeEnvelopeBackfillPayloadV1(
  context: ScopeEnvelopeBackfillActionContextV1,
): Uint8Array {
  if (!context || !onlyKeys(context, KEYS) ||
    typeof context.historicalActivationSequence !== "bigint" ||
    context.historicalActivationSequence < 1n ||
    context.historicalActivationSequence > SQLITE_MAX ||
    typeof context.currentActiveKeySequence !== "bigint" ||
    context.currentActiveKeySequence <= context.historicalActivationSequence ||
    context.currentActiveKeySequence > SQLITE_MAX ||
    typeof context.currentGrantSequence !== "bigint" ||
    context.currentGrantSequence < 1n ||
    context.currentGrantSequence > SQLITE_MAX ||
    typeof context.historicalActivationSha256 !== "string" ||
    !HASH.test(context.historicalActivationSha256))
    throw new ScopeEnvelopeBackfillActionV1Error();
  try {
    const base = encodeScopeEnvelopeActionPayloadV1({
      householdId: context.householdId,
      careProfileId: context.careProfileId,
      opaqueScopeId: context.opaqueScopeId,
      keyId: context.keyId,
      keyEpoch: context.keyEpoch,
      purpose: context.purpose,
      recipientDeviceId: context.recipientDeviceId,
      keyCommitmentSha256: context.keyCommitmentSha256,
      recipientKeySha256: context.recipientKeySha256,
      wireSha256: context.wireSha256,
      activeKeyHeadSha256: context.activeKeyHeadSha256,
      grantHeadSha256: context.grantHeadSha256,
      issuerDeviceId: context.issuerDeviceId,
      issuerCounter: context.issuerCounter,
      sessionId: context.sessionId,
      createdAt: context.createdAt,
      previousActionSha256: context.previousActionSha256,
      issuerSigningKeySha256: context.issuerSigningKeySha256,
    });
    const bytes = new Uint8Array(SCOPE_ENVELOPE_BACKFILL_PAYLOAD_BYTES_V1);
    bytes.set(base);
    bytes.set(MAGIC);
    bytes[6] = 2; // Explicit historical backfill, not ordinary issuance.
    const view = new DataView(bytes.buffer);
    let offset = base.byteLength;
    view.setBigUint64(offset, context.historicalActivationSequence, false);
    offset += 8;
    bytes.set(fromHex(context.historicalActivationSha256), offset);
    offset += 32;
    view.setBigUint64(offset, context.currentActiveKeySequence, false);
    offset += 8;
    view.setBigUint64(offset, context.currentGrantSequence, false);
    offset += 8;
    if (offset !== bytes.byteLength) throw new ScopeEnvelopeBackfillActionV1Error();
    return bytes;
  } catch { throw new ScopeEnvelopeBackfillActionV1Error(); }
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
