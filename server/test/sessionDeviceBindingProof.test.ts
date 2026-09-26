import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { encodeSessionDeviceBindingProofV1,
  SESSION_DEVICE_BINDING_PROOF_BYTES_V1,
  type SessionDeviceBindingProofContextV1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { SessionDeviceBindingDenied,
  verifySessionDeviceBindingProof } from
  "../src/managed/verifySessionDeviceBindingProof.js";

const id = (byte: string) => byte.repeat(16);
const digest = (byte: string) => byte.repeat(32);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fictionalProof() {
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const nonce = new Uint8Array(32).fill(0x91);
  const audience = new TextEncoder().encode("https://fictional.example");
  const context: SessionDeviceBindingProofContextV1 = {
    householdId: id("a1"), accountId: id("b2"), sessionId: id("c3"),
    deviceId: id("d4"), challengeId: id("e5"),
    nonceSha256: hash(nonce), audienceSha256: hash(audience),
    expiresAt: 1_800_000_300n,
  };
  const payload = encodeSessionDeviceBindingProofV1(context);
  const signature = sign(null, payload, keyPair.privateKey);
  return { context, publicKey, signature, payload };
}

it("accepts only the enrolled device's signature over the fixed fictional challenge", () => {
  const proof = fictionalProof();
  expect(proof.payload.byteLength).toBe(SESSION_DEVICE_BINDING_PROOF_BYTES_V1);
  expect(Buffer.from(proof.payload.subarray(0, 8)).toString("hex"))
    .toBe("4144534201010100");
  const expectedLayout = Buffer.concat([
    Buffer.from("4144534201010100", "hex"),
    Buffer.from(id("a1") + id("b2") + id("c3") + id("d4") + id("e5"), "hex"),
    Buffer.from(proof.context.nonceSha256 + proof.context.audienceSha256, "hex"),
    Buffer.from("000000006b49d32c", "hex"),
  ]);
  expect(Buffer.from(proof.payload)).toEqual(expectedLayout);
  expect(() => verifySessionDeviceBindingProof({
    context: proof.context, enrolledSigningPublicKey: proof.publicKey,
    signature: proof.signature,
  })).not.toThrow();
});

it("denies changed household, account, session, device, challenge, nonce, audience or expiry", () => {
  const changes: Array<(context: SessionDeviceBindingProofContextV1) => void> = [
    (value) => { value.householdId = id("01"); },
    (value) => { value.accountId = id("01"); },
    (value) => { value.sessionId = id("01"); },
    (value) => { value.deviceId = id("01"); },
    (value) => { value.challengeId = id("01"); },
    (value) => { value.nonceSha256 = digest("01"); },
    (value) => { value.audienceSha256 = digest("01"); },
    (value) => { value.expiresAt += 1n; },
  ];
  for (const change of changes) {
    const proof = fictionalProof();
    change(proof.context);
    expect(() => verifySessionDeviceBindingProof({
      context: proof.context, enrolledSigningPublicKey: proof.publicKey,
      signature: proof.signature,
    })).toThrow(SessionDeviceBindingDenied);
  }
});

it("denies another signing key, a changed signature and malformed proof bytes", () => {
  const proof = fictionalProof();
  const wrongKey = generateKeyPairSync("ed25519").publicKey
    .export({ format: "der", type: "spki" }).subarray(-32);
  expect(() => verifySessionDeviceBindingProof({
    context: proof.context, enrolledSigningPublicKey: wrongKey,
    signature: proof.signature,
  })).toThrow(SessionDeviceBindingDenied);
  const changedSignature = Uint8Array.from(proof.signature);
  changedSignature[0]! ^= 1;
  expect(() => verifySessionDeviceBindingProof({
    context: proof.context, enrolledSigningPublicKey: proof.publicKey,
    signature: changedSignature,
  })).toThrow(SessionDeviceBindingDenied);
  expect(() => verifySessionDeviceBindingProof({
    context: { ...proof.context, deviceId: proof.context.deviceId.toUpperCase() },
    enrolledSigningPublicKey: proof.publicKey, signature: proof.signature,
  })).toThrow(SessionDeviceBindingDenied);
  expect(() => verifySessionDeviceBindingProof({
    context: proof.context, enrolledSigningPublicKey: proof.publicKey,
    signature: new Uint8Array(64),
  })).toThrow(SessionDeviceBindingDenied);
});
