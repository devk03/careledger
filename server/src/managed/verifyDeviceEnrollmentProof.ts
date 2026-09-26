import { createPublicKey, timingSafeEqual,
  verify as verifySignature } from "node:crypto";

import { encodeDeviceEnrollmentProofV1,
  type DeviceEnrollmentProofContextV1 } from "@adeno/contracts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class DeviceEnrollmentDenied extends Error {
  constructor() {
    super("This device could not prove possession of its signing key.");
    this.name = "DeviceEnrollmentDenied";
  }
}

/** Ed25519 check only. The service must also check the X25519-derived nonce.
 * Neither check is family approval or account authorization. */
export function verifyDeviceEnrollmentProof(input: {
  context: DeviceEnrollmentProofContextV1;
  proposedSigningPublicKey: Uint8Array;
  signature: Uint8Array;
}): void {
  try {
    const key = copyBytes(input.proposedSigningPublicKey, 32);
    const signature = copyBytes(input.signature, 64);
    const payload = encodeDeviceEnrollmentProofV1(input.context);
    const claimed = Buffer.from(input.context.signingPublicKeyHex, "hex");
    if (claimed.byteLength !== 32 ||
      !timingSafeEqual(Buffer.from(key), claimed))
      throw new DeviceEnrollmentDenied();
    const publicKey = createPublicKey({ key: Buffer.concat([
      ED25519_SPKI_PREFIX, Buffer.from(key),
    ]), format: "der", type: "spki" });
    if (!verifySignature(null, Buffer.from(payload), publicKey,
      Buffer.from(signature))) throw new DeviceEnrollmentDenied();
  } catch { throw new DeviceEnrollmentDenied(); }
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new DeviceEnrollmentDenied();
  return Uint8Array.from(value);
}
