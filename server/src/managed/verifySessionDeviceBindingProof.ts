import { createPublicKey, verify as verifySignature } from "node:crypto";

import { encodeSessionDeviceBindingProofV1,
  type SessionDeviceBindingProofContextV1 } from "@adeno/contracts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export class SessionDeviceBindingDenied extends Error {
  constructor() {
    super("Device binding was denied.");
    this.name = "SessionDeviceBindingDenied";
  }
}

/** Cryptographic check only; the caller must load the enrolled key and
 * consume the exact live challenge in the same write transaction. */
export function verifySessionDeviceBindingProof(input: {
  context: SessionDeviceBindingProofContextV1;
  enrolledSigningPublicKey: Uint8Array;
  signature: Uint8Array;
}): void {
  try {
    const key = copyBytes(input.enrolledSigningPublicKey, 32);
    const signature = copyBytes(input.signature, 64);
    const payload = encodeSessionDeviceBindingProofV1(input.context);
    const publicKey = createPublicKey({ key: Buffer.concat([
      ED25519_SPKI_PREFIX, Buffer.from(key),
    ]), format: "der", type: "spki" });
    if (!verifySignature(null, Buffer.from(payload), publicKey,
      Buffer.from(signature))) throw new SessionDeviceBindingDenied();
  } catch { throw new SessionDeviceBindingDenied(); }
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new SessionDeviceBindingDenied();
  return Uint8Array.from(value);
}
