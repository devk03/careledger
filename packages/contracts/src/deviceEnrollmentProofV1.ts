/** Two-key possession proof; never a substitute for family approval. */
export const DEVICE_ENROLLMENT_PROOF_BYTES_V1 = 208;
export const DEVICE_ENROLLMENT_CHALLENGE_FORMAT_V1 =
  "adeno:device-enrollment-challenge:v1";
export const DEVICE_ENROLLMENT_PROOF_FORMAT_V1 =
  "adeno:device-enrollment-proof:v1";

const ID = /^[0-9a-f]{32}$/u;
const HEX32 = /^[0-9a-f]{64}$/u;
const HEX64 = /^[0-9a-f]{128}$/u;
const SQLITE_MAX = (1n << 63n) - 1n;
const NONCE_DOMAIN = new TextEncoder().encode(
  "adeno:device-enrollment-nonce:v1\0");
const CONTEXT_KEYS = ["accountId", "audienceSha256", "challengeId",
  "encryptionPublicKeyHex", "expiresAt", "householdId", "nonceSha256",
  "sessionId", "signingPublicKeyHex"];
const CHALLENGE_KEYS = ["accountId", "challengeId", "encryptionPublicKeyHex",
  "ephemeralPublicKeyHex", "expiresAt", "format", "householdId", "sessionId",
  "signingPublicKeyHex"];
const PROOF_KEYS = ["challengeId", "format", "nonceHex", "signatureHex"];

export type DeviceEnrollmentProofContextV1 = {
  householdId: string; accountId: string; sessionId: string;
  challengeId: string; nonceSha256: string; audienceSha256: string;
  encryptionPublicKeyHex: string; signingPublicKeyHex: string;
  expiresAt: bigint;
};

export type DeviceEnrollmentChallengeWireV1 = {
  format: typeof DEVICE_ENROLLMENT_CHALLENGE_FORMAT_V1;
  householdId: string; accountId: string; sessionId: string;
  challengeId: string; ephemeralPublicKeyHex: string; expiresAt: number;
  encryptionPublicKeyHex: string; signingPublicKeyHex: string;
};

export type DeviceEnrollmentProofWireV1 = {
  format: typeof DEVICE_ENROLLMENT_PROOF_FORMAT_V1;
  challengeId: string; nonceHex: string; signatureHex: string;
};

export class DeviceEnrollmentProofV1Error extends Error {
  constructor() {
    super("The device-enrollment proof has an invalid format.");
    this.name = "DeviceEnrollmentProofV1Error";
  }
}

/** Hash these exact bytes after X25519. Never transmit the shared secret. */
export function encodeDeviceEnrollmentNonceMaterialV1(input: {
  sharedSecret: Uint8Array; challengeId: string; audienceSha256: string;
}): Uint8Array {
  if (!input || !ID.test(input.challengeId) ||
    !HEX32.test(input.audienceSha256))
    throw new DeviceEnrollmentProofV1Error();
  const secret = copyBytes(input.sharedSecret, 32);
  const result = new Uint8Array(NONCE_DOMAIN.byteLength + 32 + 16 + 32);
  let offset = 0;
  for (const item of [NONCE_DOMAIN, secret, unhex(input.challengeId),
    unhex(input.audienceSha256)]) {
    result.set(item, offset);
    offset += item.byteLength;
  }
  secret.fill(0);
  return result;
}

/** Fixed-width, domain-separated bytes. Never sign JSON serialization. */
export function encodeDeviceEnrollmentProofV1(
  context: DeviceEnrollmentProofContextV1,
): Uint8Array {
  if (!context || !onlyKeys(context, CONTEXT_KEYS) ||
    ![context.householdId, context.accountId, context.sessionId,
      context.challengeId].every((v) => typeof v === "string" && ID.test(v)) ||
    ![context.nonceSha256, context.audienceSha256,
      context.encryptionPublicKeyHex, context.signingPublicKeyHex]
      .every((v) => typeof v === "string" && HEX32.test(v)) ||
    typeof context.expiresAt !== "bigint" || context.expiresAt < 1n ||
    context.expiresAt > SQLITE_MAX) throw new DeviceEnrollmentProofV1Error();
  const bytes = new Uint8Array(DEVICE_ENROLLMENT_PROOF_BYTES_V1);
  bytes.set([0x41, 0x44, 0x45, 0x4e, 1, 1, 1, 0]); // ADEN; v1; Ed25519.
  let offset = 8;
  for (const value of [context.householdId, context.accountId,
    context.sessionId, context.challengeId, context.nonceSha256,
    context.audienceSha256, context.encryptionPublicKeyHex,
    context.signingPublicKeyHex]) {
    bytes.set(unhex(value), offset);
    offset += value.length / 2;
  }
  new DataView(bytes.buffer).setBigUint64(offset, context.expiresAt, false);
  if (offset + 8 !== bytes.byteLength) throw new DeviceEnrollmentProofV1Error();
  return bytes;
}

export function encodeDeviceEnrollmentChallengeWireV1(input: {
  householdId: string; accountId: string; sessionId: string;
  challengeId: string; ephemeralPublicKey: Uint8Array; expiresAt: bigint;
  encryptionPublicKey: Uint8Array; signingPublicKey: Uint8Array;
}): DeviceEnrollmentChallengeWireV1 {
  try {
    if (typeof input.expiresAt !== "bigint" || input.expiresAt < 1n ||
      input.expiresAt > BigInt(Number.MAX_SAFE_INTEGER))
      throw new DeviceEnrollmentProofV1Error();
    const wire: DeviceEnrollmentChallengeWireV1 = {
      format: DEVICE_ENROLLMENT_CHALLENGE_FORMAT_V1,
      householdId: input.householdId, accountId: input.accountId,
      sessionId: input.sessionId, challengeId: input.challengeId,
      ephemeralPublicKeyHex: hex(copyBytes(input.ephemeralPublicKey, 32)),
      expiresAt: Number(input.expiresAt),
      encryptionPublicKeyHex: hex(copyBytes(input.encryptionPublicKey, 32)),
      signingPublicKeyHex: hex(copyBytes(input.signingPublicKey, 32)),
    };
    parseDeviceEnrollmentChallengeWireV1(wire);
    return wire;
  } catch { throw new DeviceEnrollmentProofV1Error(); }
}

export function parseDeviceEnrollmentChallengeWireV1(value: unknown): {
  householdId: string; accountId: string; sessionId: string;
  challengeId: string; ephemeralPublicKey: Uint8Array; expiresAt: bigint;
  encryptionPublicKey: Uint8Array; signingPublicKey: Uint8Array;
} {
  const fields = snapshotPlainRecord(value, CHALLENGE_KEYS);
  if (fields.format !== DEVICE_ENROLLMENT_CHALLENGE_FORMAT_V1 ||
    ![fields.householdId, fields.accountId, fields.sessionId,
      fields.challengeId].every((v) => typeof v === "string" && ID.test(v)) ||
    ![fields.ephemeralPublicKeyHex, fields.encryptionPublicKeyHex,
      fields.signingPublicKeyHex].every((v) => typeof v === "string" && HEX32.test(v)) ||
    !Number.isSafeInteger(fields.expiresAt) || (fields.expiresAt as number) < 1)
    throw new DeviceEnrollmentProofV1Error();
  return { householdId: fields.householdId as string,
    accountId: fields.accountId as string, sessionId: fields.sessionId as string,
    challengeId: fields.challengeId as string,
    ephemeralPublicKey: unhex(fields.ephemeralPublicKeyHex as string),
    expiresAt: BigInt(fields.expiresAt as number),
    encryptionPublicKey: unhex(fields.encryptionPublicKeyHex as string),
    signingPublicKey: unhex(fields.signingPublicKeyHex as string) };
}

export function encodeDeviceEnrollmentProofWireV1(input: {
  challengeId: string; nonce: Uint8Array; signature: Uint8Array;
}): DeviceEnrollmentProofWireV1 {
  try {
    const wire: DeviceEnrollmentProofWireV1 = {
      format: DEVICE_ENROLLMENT_PROOF_FORMAT_V1,
      challengeId: input.challengeId,
      nonceHex: hex(copyBytes(input.nonce, 32)),
      signatureHex: hex(copyBytes(input.signature, 64)),
    };
    parseDeviceEnrollmentProofWireV1(wire);
    return wire;
  } catch { throw new DeviceEnrollmentProofV1Error(); }
}

export function parseDeviceEnrollmentProofWireV1(value: unknown): {
  challengeId: string; nonce: Uint8Array; signature: Uint8Array;
} {
  const fields = snapshotPlainRecord(value, PROOF_KEYS);
  if (fields.format !== DEVICE_ENROLLMENT_PROOF_FORMAT_V1 ||
    typeof fields.challengeId !== "string" || !ID.test(fields.challengeId) ||
    typeof fields.nonceHex !== "string" || !HEX32.test(fields.nonceHex) ||
    typeof fields.signatureHex !== "string" || !HEX64.test(fields.signatureHex))
    throw new DeviceEnrollmentProofV1Error();
  return { challengeId: fields.challengeId,
    nonce: unhex(fields.nonceHex), signature: unhex(fields.signatureHex) };
}

function snapshotPlainRecord(value: unknown, expected: string[]):
  Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new DeviceEnrollmentProofV1Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new DeviceEnrollmentProofV1Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string"))
      throw new DeviceEnrollmentProofV1Error();
    const keys = (ownKeys as string[]).sort();
    if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]))
      throw new DeviceEnrollmentProofV1Error();
    const snapshot: Record<string, unknown> = Object.create(null) as
      Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new DeviceEnrollmentProofV1Error();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch { throw new DeviceEnrollmentProofV1Error(); }
}

function onlyKeys(value: object, expected: string[]): boolean {
  try {
    const keys = Object.keys(value).sort();
    return keys.length === expected.length &&
      keys.every((key, index) => key === expected[index]);
  } catch { return false; }
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new DeviceEnrollmentProofV1Error();
  return Uint8Array.from(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i++)
    result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}
