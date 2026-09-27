/**
 * A short out-of-band comparison code for the adult approving a newly enrolled
 * device. It is not a credential, signature, key grant, or approval by itself.
 */
const DOMAIN = new TextEncoder().encode("adeno:managed:device-approval:v1\0");
const ID = /^[0-9a-f]{32}$/u;
const CODE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/iu;

export class DeviceApprovalCodeV1Error extends Error {
  constructor() {
    super("The device approval code could not be verified.");
    this.name = "DeviceApprovalCodeV1Error";
  }
}

export type DeviceApprovalIdentityV1 = {
  householdId: string;
  accountId: string;
  deviceId: string;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
};

/** Hash these exact fixed-width bytes with SHA-256 on the candidate device. */
export function encodeDeviceApprovalCodeMaterialV1(input: DeviceApprovalIdentityV1):
  Uint8Array {
  if (!input || ![input.householdId, input.accountId, input.deviceId]
    .every((value) => typeof value === "string" && ID.test(value)) ||
    !(input.encryptionPublicKey instanceof Uint8Array) ||
    input.encryptionPublicKey.byteLength !== 32 ||
    !(input.signingPublicKey instanceof Uint8Array) ||
    input.signingPublicKey.byteLength !== 32)
    throw new DeviceApprovalCodeV1Error();
  const bytes = new Uint8Array(DOMAIN.byteLength + 16 + 16 + 16 + 32 + 32);
  let offset = 0;
  for (const value of [DOMAIN, unhex(input.householdId),
    unhex(input.accountId), unhex(input.deviceId),
    Uint8Array.from(input.encryptionPublicKey),
    Uint8Array.from(input.signingPublicKey)]) {
    bytes.set(value, offset);
    offset += value.byteLength;
  }
  return bytes;
}

/** Display the first 48 digest bits as three four-character groups. */
export function formatDeviceApprovalCodeV1(sha256: Uint8Array): string {
  if (!(sha256 instanceof Uint8Array) || sha256.byteLength !== 32)
    throw new DeviceApprovalCodeV1Error();
  const prefix = Array.from(sha256.subarray(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
  return `${prefix.slice(0, 4)}-${prefix.slice(4, 8)}-${prefix.slice(8, 12)}`;
}

export function isDeviceApprovalCodeV1(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}

function unhex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i++)
    result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}
