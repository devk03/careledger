/** Canonical HPKE framing only. Opening a wire never authorizes a recipient. */
export const SCOPE_KEY_ENVELOPE_FORMAT_V2 =
  "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2" as const;
export const SCOPE_KEY_HEADER_BYTES_V2 = 192;
export const SCOPE_KEY_WIRE_BYTES_V2 = 240;

const MAGIC = new Uint8Array([0x41, 0x44, 0x4b, 0x59]); // ADKY, version 2.
const VERSION = 2;
const SUITE = 1;
const BASE_MODE = 0; // Sender authentication must come from a signed action.
const ID_BYTES = 16;
const DIGEST_BYTES = 32;
const ENCAPSULATED_BYTES = 32;
const CIPHERTEXT_BYTES = 48;
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTITY_KEYS = ["careProfileId", "householdId", "keyEpoch", "keyId",
  "opaqueScopeId", "purpose"];
const CONTEXT_KEYS = [...IDENTITY_KEYS, "recipientDeviceId"];
const ENVELOPE_KEYS = ["ciphertext", "context", "encapsulatedKey", "format",
  "keyCommitmentSha256", "recipientKeySha256"];
const TYPED_ARRAY_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
const ARRAY_BUFFER_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype, "byteLength")?.get;

export type ScopeKeyPurposeV2 = "day" | "source" | "draft" | "index";
export type ScopeKeyIdentityV2 = {
  householdId: string;
  careProfileId: string;
  opaqueScopeId: string;
  keyId: string;
  keyEpoch: number;
  purpose: ScopeKeyPurposeV2;
};
export type ScopeKeyContextV2 = ScopeKeyIdentityV2 & {
  recipientDeviceId: string;
};
export type ScopeKeyEnvelopeV2 = {
  format: typeof SCOPE_KEY_ENVELOPE_FORMAT_V2;
  context: ScopeKeyContextV2;
  keyCommitmentSha256: string;
  recipientKeySha256: string;
  encapsulatedKey: Uint8Array;
  ciphertext: ArrayBuffer;
};

export class ScopeKeyEnvelopeWireV2Error extends Error {
  constructor() {
    super("This encrypted scope key has an invalid v2 storage format.");
    this.name = "ScopeKeyEnvelopeWireV2Error";
  }
}

export function assertScopeKeyEnvelopeV2(envelope: ScopeKeyEnvelopeV2): void {
  if (!envelope || !hasOnlyKeys(envelope, ENVELOPE_KEYS) ||
    envelope.format !== SCOPE_KEY_ENVELOPE_FORMAT_V2 ||
    typeof envelope.keyCommitmentSha256 !== "string" ||
    !SHA256.test(envelope.keyCommitmentSha256) ||
    typeof envelope.recipientKeySha256 !== "string" ||
    !SHA256.test(envelope.recipientKeySha256) ||
    !isBytes(envelope.encapsulatedKey) ||
    envelope.encapsulatedKey.byteLength !== ENCAPSULATED_BYTES ||
    arrayBufferLength(envelope.ciphertext) !== CIPHERTEXT_BYTES)
    throw new ScopeKeyEnvelopeWireV2Error();
  assertContext(envelope.context);
}

/** The complete header is HPKE AAD; it includes key identity and commitment. */
export function encodeScopeKeyHeaderV2(envelope: Pick<ScopeKeyEnvelopeV2,
  "format" | "context" | "keyCommitmentSha256" | "recipientKeySha256" |
  "encapsulatedKey">): Uint8Array {
  if (!envelope || envelope.format !== SCOPE_KEY_ENVELOPE_FORMAT_V2 ||
    typeof envelope.keyCommitmentSha256 !== "string" ||
    !SHA256.test(envelope.keyCommitmentSha256) ||
    typeof envelope.recipientKeySha256 !== "string" ||
    !SHA256.test(envelope.recipientKeySha256) ||
    !isBytes(envelope.encapsulatedKey) ||
    envelope.encapsulatedKey.byteLength !== ENCAPSULATED_BYTES)
    throw new ScopeKeyEnvelopeWireV2Error();
  assertContext(envelope.context);
  const header = new Uint8Array(SCOPE_KEY_HEADER_BYTES_V2);
  header.set(MAGIC);
  header[4] = VERSION;
  header[5] = SUITE;
  header[6] = BASE_MODE;
  let offset = 8;
  for (const id of [envelope.context.householdId,
    envelope.context.careProfileId, envelope.context.opaqueScopeId,
    envelope.context.keyId, envelope.context.recipientDeviceId]) {
    header.set(fromHex(id), offset);
    offset += ID_BYTES;
  }
  new DataView(header.buffer).setUint32(offset, envelope.context.keyEpoch, false);
  offset += 4;
  header[offset] = purposeCode(envelope.context.purpose);
  offset += 4; // Three reserved bytes remain zero.
  header.set(fromHex(envelope.keyCommitmentSha256), offset);
  offset += DIGEST_BYTES;
  header.set(fromHex(envelope.recipientKeySha256), offset);
  offset += DIGEST_BYTES;
  header.set(envelope.encapsulatedKey, offset);
  return header;
}

export function encodeScopeKeyEnvelopeV2(envelope: ScopeKeyEnvelopeV2): Uint8Array {
  assertScopeKeyEnvelopeV2(envelope);
  const wire = new Uint8Array(SCOPE_KEY_WIRE_BYTES_V2);
  wire.set(encodeScopeKeyHeaderV2(envelope));
  wire.set(new Uint8Array(envelope.ciphertext), SCOPE_KEY_HEADER_BYTES_V2);
  return wire;
}

/** Exact version, exact length, copied fields; never infers a grant or sender. */
export function decodeScopeKeyEnvelopeV2(input: Uint8Array): ScopeKeyEnvelopeV2 {
  if (!isBytes(input) || input.byteLength !== SCOPE_KEY_WIRE_BYTES_V2)
    throw new ScopeKeyEnvelopeWireV2Error();
  const wire = Uint8Array.from(input);
  if (MAGIC.some((byte, index) => wire[index] !== byte) ||
    wire[4] !== VERSION || wire[5] !== SUITE || wire[6] !== BASE_MODE ||
    wire[7] !== 0 || wire[93] !== 0 || wire[94] !== 0 || wire[95] !== 0)
    throw new ScopeKeyEnvelopeWireV2Error();
  let offset = 8;
  const field = (length: number) => {
    const value = wire.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const householdId = hex(field(ID_BYTES));
  const careProfileId = hex(field(ID_BYTES));
  const opaqueScopeId = hex(field(ID_BYTES));
  const keyId = hex(field(ID_BYTES));
  const recipientDeviceId = hex(field(ID_BYTES));
  const keyEpoch = new DataView(wire.buffer).getUint32(offset, false);
  offset += 4;
  if (keyEpoch < 1) throw new ScopeKeyEnvelopeWireV2Error();
  const purpose = codePurpose(wire[offset]!);
  offset += 4;
  const keyCommitmentSha256 = hex(field(DIGEST_BYTES));
  const recipientKeySha256 = hex(field(DIGEST_BYTES));
  const encapsulatedKey = field(ENCAPSULATED_BYTES);
  const ciphertext = new ArrayBuffer(CIPHERTEXT_BYTES);
  new Uint8Array(ciphertext).set(field(CIPHERTEXT_BYTES));
  if (offset !== SCOPE_KEY_WIRE_BYTES_V2) throw new ScopeKeyEnvelopeWireV2Error();
  return { format: SCOPE_KEY_ENVELOPE_FORMAT_V2,
    context: { householdId, careProfileId, opaqueScopeId, keyId, keyEpoch,
      purpose, recipientDeviceId }, keyCommitmentSha256,
    recipientKeySha256, encapsulatedKey, ciphertext };
}

function assertContext(context: ScopeKeyContextV2): void {
  if (!context || !hasOnlyKeys(context, CONTEXT_KEYS) ||
    ![context.householdId, context.careProfileId, context.opaqueScopeId,
      context.keyId, context.recipientDeviceId].every((id) =>
      typeof id === "string" && OPAQUE_ID.test(id)) ||
    !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1 ||
    context.keyEpoch > 0xffffffff)
    throw new ScopeKeyEnvelopeWireV2Error();
  purposeCode(context.purpose);
}

function purposeCode(purpose: ScopeKeyPurposeV2): number {
  if (purpose === "day") return 1;
  if (purpose === "source") return 2;
  if (purpose === "draft") return 3;
  if (purpose === "index") return 4;
  throw new ScopeKeyEnvelopeWireV2Error();
}

function codePurpose(code: number): ScopeKeyPurposeV2 {
  if (code === 1) return "day";
  if (code === 2) return "source";
  if (code === 3) return "draft";
  if (code === 4) return "index";
  throw new ScopeKeyEnvelopeWireV2Error();
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isBytes(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value) || !TYPED_ARRAY_TAG) return false;
  try { return TYPED_ARRAY_TAG.call(value) === "Uint8Array"; }
  catch { return false; }
}

function arrayBufferLength(value: unknown): number | null {
  if (!ARRAY_BUFFER_LENGTH) return null;
  try { return ARRAY_BUFFER_LENGTH.call(value) as number; }
  catch { return null; }
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function hex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
