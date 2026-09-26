/** Exact Ed25519 message for binding one enrolled device to one login session. */
export const SESSION_DEVICE_BINDING_PROOF_BYTES_V1 = 160;

const MAGIC = new Uint8Array([0x41, 0x44, 0x53, 0x42]); // ADSB.
const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const SQLITE_MAX = (1n << 63n) - 1n;
const KEYS = ["accountId", "audienceSha256", "challengeId", "deviceId",
  "expiresAt", "householdId", "nonceSha256", "sessionId"];

export type SessionDeviceBindingProofContextV1 = {
  householdId: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  challengeId: string;
  nonceSha256: string;
  audienceSha256: string;
  expiresAt: bigint;
};

export class SessionDeviceBindingProofV1Error extends Error {
  constructor() {
    super("The device-binding proof has an invalid format.");
    this.name = "SessionDeviceBindingProofV1Error";
  }
}

/** Fixed-width, domain-separated bytes; never sign JSON serialization. */
export function encodeSessionDeviceBindingProofV1(
  context: SessionDeviceBindingProofContextV1,
): Uint8Array {
  if (!context || !onlyKeys(context, KEYS) ||
    ![context.householdId, context.accountId, context.sessionId,
      context.deviceId, context.challengeId]
      .every((value) => typeof value === "string" && ID.test(value)) ||
    ![context.nonceSha256, context.audienceSha256]
      .every((value) => typeof value === "string" && HASH.test(value)) ||
    typeof context.expiresAt !== "bigint" || context.expiresAt < 1n ||
    context.expiresAt > SQLITE_MAX)
    throw new SessionDeviceBindingProofV1Error();

  const bytes = new Uint8Array(SESSION_DEVICE_BINDING_PROOF_BYTES_V1);
  const view = new DataView(bytes.buffer);
  bytes.set(MAGIC);
  bytes[4] = 1; // Format version.
  bytes[5] = 1; // Ed25519 + SHA-256.
  bytes[6] = 1; // Bind device to session, not another action kind.
  let offset = 8;
  for (const id of [context.householdId, context.accountId,
    context.sessionId, context.deviceId, context.challengeId]) {
    bytes.set(fromHex(id), offset);
    offset += 16;
  }
  for (const hash of [context.nonceSha256, context.audienceSha256]) {
    bytes.set(fromHex(hash), offset);
    offset += 32;
  }
  view.setBigUint64(offset, context.expiresAt, false);
  offset += 8;
  if (offset !== bytes.byteLength) throw new SessionDeviceBindingProofV1Error();
  return bytes;
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
