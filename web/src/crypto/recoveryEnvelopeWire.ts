import { RECOVERY_FORMAT, RECOVERY_KDF_PROFILE,
  type RecoveryEnvelope } from "./recovery.js";

const MAGIC = new Uint8Array([0x41, 0x44, 0x52, 0x4b]); // ADRK
const VERSION = 1;
const SALT_BYTES = 16;
const ENVELOPE_ID_BYTES = 16;
const IV_BYTES = 12;
const CIPHERTEXT_BYTES = 48;
const WIRE_BYTES = MAGIC.length + 1 + SALT_BYTES + ENVELOPE_ID_BYTES +
  IV_BYTES + CIPHERTEXT_BYTES;

export class RecoveryEnvelopeWireError extends Error {
  constructor() {
    super("This encrypted recovery envelope has an invalid format.");
    this.name = "RecoveryEnvelopeWireError";
  }
}

/** Contains only the wrapped vault key; the caregiver-held code is never serialized. */
export function encodeRecoveryEnvelope(envelope: RecoveryEnvelope): Uint8Array {
  if (!envelope || envelope.format !== RECOVERY_FORMAT ||
    envelope.kdfProfile !== RECOVERY_KDF_PROFILE ||
    !validBytes(envelope.salt, SALT_BYTES) ||
    !validBytes(envelope.envelopeId, ENVELOPE_ID_BYTES) ||
    !validBytes(envelope.iv, IV_BYTES) ||
    Object.prototype.toString.call(envelope.ciphertext) !== "[object ArrayBuffer]" ||
    envelope.ciphertext.byteLength !== CIPHERTEXT_BYTES) {
    throw new RecoveryEnvelopeWireError();
  }
  const wire = new Uint8Array(WIRE_BYTES);
  wire.set(MAGIC, 0);
  wire[MAGIC.length] = VERSION;
  let offset = MAGIC.length + 1;
  for (const field of [envelope.salt, envelope.envelopeId, envelope.iv,
    new Uint8Array(envelope.ciphertext)]) {
    wire.set(field, offset);
    offset += field.byteLength;
  }
  return wire;
}

/** Exact-length parser. Authenticity is verified by recoverVault's AES-GCM check. */
export function decodeRecoveryEnvelope(wire: Uint8Array): RecoveryEnvelope {
  if (!(wire instanceof Uint8Array) || wire.byteLength !== WIRE_BYTES ||
    MAGIC.some((byte, index) => wire[index] !== byte) ||
    wire[MAGIC.length] !== VERSION) throw new RecoveryEnvelopeWireError();
  let offset = MAGIC.length + 1;
  const field = (size: number): Uint8Array => {
    const value = wire.slice(offset, offset + size);
    offset += size;
    return value;
  };
  const salt = field(SALT_BYTES);
  const envelopeId = field(ENVELOPE_ID_BYTES);
  const iv = field(IV_BYTES);
  const ciphertext = new ArrayBuffer(CIPHERTEXT_BYTES);
  new Uint8Array(ciphertext).set(field(CIPHERTEXT_BYTES));
  return { format: RECOVERY_FORMAT, kdfProfile: RECOVERY_KDF_PROFILE,
    salt, envelopeId, iv, ciphertext };
}

function validBytes(value: unknown, size: number): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === size;
}
