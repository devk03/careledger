import { assertDayKeyEnvelopeShape, DAY_KEY_ENVELOPE_FORMAT,
  DAY_KEY_HEADER_BYTES, DAY_KEY_WIRE_BYTES, encodeDayKeyHeader,
  type DayKeyEnvelope } from "./dayKeyEnvelope";

const MAGIC = new Uint8Array([0x41, 0x44, 0x4b, 0x59]); // ADKY
const VERSION = 1;
const SUITE = 1;
const AUTH_MODE = 0;
const RESERVED = 0;
const ID_BYTES = 16;
const FINGERPRINT_BYTES = 32;
const ENCAPSULATED_BYTES = 32;
const CIPHERTEXT_BYTES = 48;

export class DayKeyEnvelopeWireError extends Error {
  constructor() {
    super("This encrypted care-day key has an invalid storage format.");
    this.name = "DayKeyEnvelopeWireError";
  }
}

/** Opaque metadata and HPKE ciphertext only. Not proof of issuer or current grant. */
export function encodeDayKeyEnvelope(envelope: DayKeyEnvelope): Uint8Array {
  try { assertDayKeyEnvelopeShape(envelope); }
  catch { throw new DayKeyEnvelopeWireError(); }
  const wire = new Uint8Array(DAY_KEY_WIRE_BYTES);
  wire.set(encodeDayKeyHeader(envelope));
  wire.set(new Uint8Array(envelope.ciphertext), DAY_KEY_HEADER_BYTES);
  return wire;
}

/** Parses one exact versioned record; authenticity is checked only by HPKE open. */
export function decodeDayKeyEnvelope(wire: Uint8Array): DayKeyEnvelope {
  if (!(wire instanceof Uint8Array) || wire.byteLength !== DAY_KEY_WIRE_BYTES ||
    MAGIC.some((byte, index) => wire[index] !== byte) || wire[4] !== VERSION ||
    wire[5] !== SUITE || wire[6] !== AUTH_MODE || wire[7] !== RESERVED)
    throw new DayKeyEnvelopeWireError();
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
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

function toHex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
