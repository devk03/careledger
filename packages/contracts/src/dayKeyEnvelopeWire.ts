/** Opaque HPKE envelope framing only. Parsing is never authorization. */
export const DAY_KEY_ENVELOPE_FORMAT = "hpke-x25519-hkdf-sha256-aes256gcm-v1" as const;
export const DAY_KEY_HEADER_BYTES = 140;
export const DAY_KEY_WIRE_BYTES = 188;

const MAGIC = new Uint8Array([0x41, 0x44, 0x4b, 0x59]); // ADKY
const VERSION = 1;
const SUITE = 1;
const AUTH_MODE = 0; // HPKE base mode; sender is not authenticated.
const RESERVED = 0;
const ID_BYTES = 16;
const FINGERPRINT_BYTES = 32;
const ENCAPSULATED_BYTES = 32;
const CIPHERTEXT_BYTES = 48;
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const IDENTITY_KEYS = ["careProfileId", "householdId", "keyEpoch", "opaqueDayId"];
const CONTEXT_KEYS = [...IDENTITY_KEYS, "recipientDeviceId"];
const ENVELOPE_KEYS = ["ciphertext", "context", "encapsulatedKey", "format",
  "recipientKeySha256"];

export type DayKeyIdentity = {
  householdId: string;
  careProfileId: string;
  opaqueDayId: string;
  keyEpoch: number;
};

export type DayKeyContext = DayKeyIdentity & { recipientDeviceId: string };

export type DayKeyEnvelope = {
  format: typeof DAY_KEY_ENVELOPE_FORMAT;
  context: DayKeyContext;
  recipientKeySha256: string;
  encapsulatedKey: Uint8Array;
  ciphertext: ArrayBuffer;
};

export class DayKeyEnvelopeWireError extends Error {
  constructor() {
    super("This encrypted care-day key has an invalid storage format.");
    this.name = "DayKeyEnvelopeWireError";
  }
}

/** Structural validation only; HPKE open and signed-grant checks are separate. */
export function assertDayKeyEnvelopeShape(envelope: DayKeyEnvelope): void {
  if (!envelope || !hasOnlyKeys(envelope, ENVELOPE_KEYS) ||
    envelope.format !== DAY_KEY_ENVELOPE_FORMAT || !envelope.context ||
    !FINGERPRINT.test(envelope.recipientKeySha256) ||
    !isBytes(envelope.encapsulatedKey) ||
    envelope.encapsulatedKey.byteLength !== ENCAPSULATED_BYTES ||
    Object.prototype.toString.call(envelope.ciphertext) !== "[object ArrayBuffer]" ||
    envelope.ciphertext.byteLength !== CIPHERTEXT_BYTES)
    throw new DayKeyEnvelopeWireError();
  assertDayKeyContext(envelope.context);
}

/** Header bytes are canonical HPKE associated data, not a source of authority. */
export function encodeDayKeyHeader(envelope: Pick<DayKeyEnvelope,
  "format" | "context" | "recipientKeySha256" | "encapsulatedKey">): Uint8Array {
  if (envelope?.format !== DAY_KEY_ENVELOPE_FORMAT || !envelope.context ||
    !FINGERPRINT.test(envelope.recipientKeySha256) ||
    !isBytes(envelope.encapsulatedKey) ||
    envelope.encapsulatedKey.byteLength !== ENCAPSULATED_BYTES)
    throw new DayKeyEnvelopeWireError();
  assertDayKeyContext(envelope.context);
  const header = new Uint8Array(DAY_KEY_HEADER_BYTES);
  header.set(MAGIC);
  header[4] = VERSION;
  header[5] = SUITE;
  header[6] = AUTH_MODE;
  header[7] = RESERVED;
  let offset = 8;
  for (const id of [envelope.context.householdId, envelope.context.careProfileId,
    envelope.context.opaqueDayId, envelope.context.recipientDeviceId]) {
    header.set(fromHex(id), offset);
    offset += ID_BYTES;
  }
  new DataView(header.buffer).setUint32(offset, envelope.context.keyEpoch, false);
  offset += 4;
  header.set(fromHex(envelope.recipientKeySha256), offset);
  offset += FINGERPRINT_BYTES;
  header.set(envelope.encapsulatedKey, offset);
  return header;
}

/** Exactly 188 bytes. No dates, filenames, notes, optional fields, or keys. */
export function encodeDayKeyEnvelope(envelope: DayKeyEnvelope): Uint8Array {
  assertDayKeyEnvelopeShape(envelope);
  const wire = new Uint8Array(DAY_KEY_WIRE_BYTES);
  wire.set(encodeDayKeyHeader(envelope));
  wire.set(new Uint8Array(envelope.ciphertext), DAY_KEY_HEADER_BYTES);
  return wire;
}

/** Parses one exact version; returned byte fields never alias the caller's input. */
export function decodeDayKeyEnvelope(input: Uint8Array): DayKeyEnvelope {
  if (!isBytes(input) || input.byteLength !== DAY_KEY_WIRE_BYTES)
    throw new DayKeyEnvelopeWireError();
  const wire = Uint8Array.from(input);
  if (MAGIC.some((byte, index) => wire[index] !== byte) ||
    wire[4] !== VERSION || wire[5] !== SUITE ||
    wire[6] !== AUTH_MODE || wire[7] !== RESERVED)
    throw new DayKeyEnvelopeWireError();
  const view = new DataView(wire.buffer);
  let offset = 8;
  const field = (length: number): Uint8Array => {
    const value = wire.slice(offset, offset + length);
    offset += length;
    return value;
  };
  const householdId = toHex(field(ID_BYTES));
  const careProfileId = toHex(field(ID_BYTES));
  const opaqueDayId = toHex(field(ID_BYTES));
  const recipientDeviceId = toHex(field(ID_BYTES));
  const keyEpoch = view.getUint32(offset, false);
  offset += 4;
  if (keyEpoch < 1) throw new DayKeyEnvelopeWireError();
  const recipientKeySha256 = toHex(field(FINGERPRINT_BYTES));
  const encapsulatedKey = field(ENCAPSULATED_BYTES);
  const ciphertext = new ArrayBuffer(CIPHERTEXT_BYTES);
  new Uint8Array(ciphertext).set(field(CIPHERTEXT_BYTES));
  if (offset !== DAY_KEY_WIRE_BYTES) throw new DayKeyEnvelopeWireError();
  return { format: DAY_KEY_ENVELOPE_FORMAT,
    context: { householdId, careProfileId, opaqueDayId, keyEpoch, recipientDeviceId },
    recipientKeySha256, encapsulatedKey, ciphertext };
}

function assertDayKeyContext(context: DayKeyContext): void {
  if (!context || !hasOnlyKeys(context, CONTEXT_KEYS)) throw new DayKeyEnvelopeWireError();
  for (const id of [context.householdId, context.careProfileId,
    context.opaqueDayId, context.recipientDeviceId]) {
    if (typeof id !== "string" || !OPAQUE_ID.test(id)) throw new DayKeyEnvelopeWireError();
  }
  if (!Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1 ||
    context.keyEpoch > 0xffffffff) throw new DayKeyEnvelopeWireError();
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function toHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
