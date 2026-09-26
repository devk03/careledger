/** JSON-safe transport only. Authorization and signature checks are separate. */
export const SESSION_DEVICE_CHALLENGE_FORMAT_V1 =
  "adeno:session-device-challenge:v1";
export const SESSION_DEVICE_PROOF_FORMAT_V1 =
  "adeno:session-device-proof:v1";

const ID = /^[0-9a-f]{32}$/u;
const NONCE = /^[0-9a-f]{64}$/u;
const SIGNATURE = /^[0-9a-f]{128}$/u;
const CHALLENGE_KEYS = ["accountId", "challengeId", "deviceId", "expiresAt",
  "format", "householdId", "nonceHex", "sessionId"];
const PROOF_KEYS = ["challengeId", "format", "nonceHex", "signatureHex"];

export type SessionDeviceChallengeWireV1 = {
  format: typeof SESSION_DEVICE_CHALLENGE_FORMAT_V1;
  householdId: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  challengeId: string;
  nonceHex: string;
  expiresAt: number;
};

export type SessionDeviceProofWireV1 = {
  format: typeof SESSION_DEVICE_PROOF_FORMAT_V1;
  challengeId: string;
  nonceHex: string;
  signatureHex: string;
};

export class SessionDeviceBindingWireV1Error extends Error {
  constructor() {
    super("The device-binding message has an invalid format.");
    this.name = "SessionDeviceBindingWireV1Error";
  }
}

export function encodeSessionDeviceChallengeWireV1(input: {
  householdId: string; accountId: string; sessionId: string;
  deviceId: string; challengeId: string; nonce: Uint8Array;
  expiresAt: bigint;
}): SessionDeviceChallengeWireV1 {
  try {
    if (typeof input.expiresAt !== "bigint" || input.expiresAt < 1n ||
      input.expiresAt > BigInt(Number.MAX_SAFE_INTEGER))
      throw new SessionDeviceBindingWireV1Error();
    const wire: SessionDeviceChallengeWireV1 = {
      format: SESSION_DEVICE_CHALLENGE_FORMAT_V1,
      householdId: input.householdId, accountId: input.accountId,
      sessionId: input.sessionId, deviceId: input.deviceId,
      challengeId: input.challengeId, nonceHex: hex(copyBytes(input.nonce, 32)),
      expiresAt: Number(input.expiresAt) };
    parseSessionDeviceChallengeWireV1(wire);
    return wire;
  } catch { throw new SessionDeviceBindingWireV1Error(); }
}

export function parseSessionDeviceChallengeWireV1(value: unknown): {
  householdId: string; accountId: string; sessionId: string;
  deviceId: string; challengeId: string; nonce: Uint8Array;
  expiresAt: bigint;
} {
  const fields = snapshotPlainRecord(value, CHALLENGE_KEYS);
  if (fields.format !== SESSION_DEVICE_CHALLENGE_FORMAT_V1 ||
    ![fields.householdId, fields.accountId, fields.sessionId,
      fields.deviceId, fields.challengeId]
      .every((field) => typeof field === "string" && ID.test(field)) ||
    typeof fields.nonceHex !== "string" || !NONCE.test(fields.nonceHex) ||
    !Number.isSafeInteger(fields.expiresAt) ||
    (fields.expiresAt as number) < 1)
    throw new SessionDeviceBindingWireV1Error();
  return { householdId: fields.householdId as string,
    accountId: fields.accountId as string, sessionId: fields.sessionId as string,
    deviceId: fields.deviceId as string, challengeId: fields.challengeId as string,
    nonce: unhex(fields.nonceHex),
    expiresAt: BigInt(fields.expiresAt as number) };
}

export function encodeSessionDeviceProofWireV1(input: {
  challengeId: string; nonce: Uint8Array; signature: Uint8Array;
}): SessionDeviceProofWireV1 {
  try {
    const wire: SessionDeviceProofWireV1 = {
      format: SESSION_DEVICE_PROOF_FORMAT_V1,
      challengeId: input.challengeId, nonceHex: hex(copyBytes(input.nonce, 32)),
      signatureHex: hex(copyBytes(input.signature, 64)) };
    parseSessionDeviceProofWireV1(wire);
    return wire;
  } catch { throw new SessionDeviceBindingWireV1Error(); }
}

export function parseSessionDeviceProofWireV1(value: unknown): {
  challengeId: string; nonce: Uint8Array; signature: Uint8Array;
} {
  const fields = snapshotPlainRecord(value, PROOF_KEYS);
  if (fields.format !== SESSION_DEVICE_PROOF_FORMAT_V1 ||
    typeof fields.challengeId !== "string" || !ID.test(fields.challengeId) ||
    typeof fields.nonceHex !== "string" || !NONCE.test(fields.nonceHex) ||
    typeof fields.signatureHex !== "string" ||
    !SIGNATURE.test(fields.signatureHex))
    throw new SessionDeviceBindingWireV1Error();
  return { challengeId: fields.challengeId,
    nonce: unhex(fields.nonceHex), signature: unhex(fields.signatureHex) };
}

function snapshotPlainRecord(value: unknown, expected: string[]):
  Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new SessionDeviceBindingWireV1Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new SessionDeviceBindingWireV1Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== "string"))
      throw new SessionDeviceBindingWireV1Error();
    const keys = (ownKeys as string[]).sort();
    if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]))
      throw new SessionDeviceBindingWireV1Error();
    const snapshot: Record<string, unknown> = Object.create(null) as
      Record<string, unknown>;
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new SessionDeviceBindingWireV1Error();
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch { throw new SessionDeviceBindingWireV1Error(); }
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new SessionDeviceBindingWireV1Error();
  return Uint8Array.from(value);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index++)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}
