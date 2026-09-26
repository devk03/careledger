import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { encodeDeviceEnrollmentChallengeWireV1,
  encodeDeviceEnrollmentNonceMaterialV1,
  encodeDeviceEnrollmentProofV1, encodeDeviceEnrollmentProofWireV1,
  parseDeviceEnrollmentChallengeWireV1, parseDeviceEnrollmentProofWireV1,
  DEVICE_ENROLLMENT_PROOF_BYTES_V1, DeviceEnrollmentProofV1Error,
  type DeviceEnrollmentProofContextV1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { DeviceEnrollmentDenied,
  verifyDeviceEnrollmentProof } from
  "../src/managed/verifyDeviceEnrollmentProof.js";

const id = (byte: string) => byte.repeat(16);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

it("domain-separates the X25519-derived nonce from other key uses", () => {
  const material = encodeDeviceEnrollmentNonceMaterialV1({
    sharedSecret: new Uint8Array(32).fill(0xab),
    challengeId: id("d4"), audienceSha256: "01".repeat(32),
  });
  expect(Buffer.from(material)).toEqual(Buffer.concat([
    Buffer.from("adeno:device-enrollment-nonce:v1\0"),
    Buffer.alloc(32, 0xab), Buffer.from(id("d4"), "hex"),
    Buffer.alloc(32, 1),
  ]));
});

function fictionalProof() {
  const signer = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const signingKey = signer.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const encryptionKey = encryption.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const nonce = new Uint8Array(32).fill(0x37);
  const context: DeviceEnrollmentProofContextV1 = {
    householdId: id("a1"), accountId: id("b2"), sessionId: id("c3"),
    challengeId: id("d4"), nonceSha256: hash(nonce),
    audienceSha256: hash(new TextEncoder().encode("https://fictional.example")),
    encryptionPublicKeyHex: encryptionKey.toString("hex"),
    signingPublicKeyHex: signingKey.toString("hex"),
    expiresAt: 1_800_000_600n,
  };
  const payload = encodeDeviceEnrollmentProofV1(context);
  const signature = sign(null, Buffer.from(payload), signer.privateKey);
  return { context, payload, signature, signingKey, encryptionKey, nonce,
    signingPrivateKey: signer.privateKey };
}

it("requires a fixed domain-separated signature over both proposed keys", () => {
  const proof = fictionalProof();
  expect(proof.payload.byteLength).toBe(DEVICE_ENROLLMENT_PROOF_BYTES_V1);
  expect(Buffer.from(proof.payload.subarray(0, 8)).toString("hex"))
    .toBe("4144454e01010100");
  expect(() => verifyDeviceEnrollmentProof({ context: proof.context,
    proposedSigningPublicKey: proof.signingKey,
    signature: proof.signature })).not.toThrow();
  const changed: DeviceEnrollmentProofContextV1[] = [
    { ...proof.context, householdId: id("01") },
    { ...proof.context, accountId: id("01") },
    { ...proof.context, sessionId: id("01") },
    { ...proof.context, challengeId: id("01") },
    { ...proof.context, nonceSha256: "01".repeat(32) },
    { ...proof.context, audienceSha256: "01".repeat(32) },
    { ...proof.context, encryptionPublicKeyHex: "01".repeat(32) },
    { ...proof.context, signingPublicKeyHex: "01".repeat(32) },
    { ...proof.context, expiresAt: proof.context.expiresAt + 1n },
  ];
  for (const context of changed) expect(() => verifyDeviceEnrollmentProof({
    context, proposedSigningPublicKey: proof.signingKey,
    signature: proof.signature,
  })).toThrow(DeviceEnrollmentDenied);
  const other = generateKeyPairSync("ed25519").publicKey
    .export({ format: "der", type: "spki" }).subarray(-32);
  const falseClaim = { ...proof.context,
    signingPublicKeyHex: other.toString("hex") };
  expect(() => verifyDeviceEnrollmentProof({
    context: falseClaim,
    proposedSigningPublicKey: proof.signingKey,
    signature: sign(null, Buffer.from(encodeDeviceEnrollmentProofV1(falseClaim)),
      proof.signingPrivateKey),
  })).toThrow(DeviceEnrollmentDenied);
  expect(() => verifyDeviceEnrollmentProof({ context: proof.context,
    proposedSigningPublicKey: other,
    signature: proof.signature })).toThrow(DeviceEnrollmentDenied);
});

it("round-trips exact JSON challenge and proof without ambiguous fields", () => {
  const proof = fictionalProof();
  const challenge = encodeDeviceEnrollmentChallengeWireV1({
    householdId: proof.context.householdId,
    accountId: proof.context.accountId,
    sessionId: proof.context.sessionId,
    challengeId: proof.context.challengeId,
    ephemeralPublicKey: proof.encryptionKey,
    expiresAt: proof.context.expiresAt,
    encryptionPublicKey: proof.encryptionKey,
    signingPublicKey: proof.signingKey,
  });
  expect(parseDeviceEnrollmentChallengeWireV1(
    JSON.parse(JSON.stringify(challenge)) as unknown).ephemeralPublicKey)
    .toEqual(Uint8Array.from(proof.encryptionKey));
  const wire = encodeDeviceEnrollmentProofWireV1({
    challengeId: challenge.challengeId, nonce: proof.nonce,
    signature: proof.signature,
  });
  expect(parseDeviceEnrollmentProofWireV1(
    JSON.parse(JSON.stringify(wire)) as unknown).signature)
    .toEqual(Uint8Array.from(proof.signature));
  for (const malformed of [
    { ...challenge, encryptionPublicKeyHex: "00" },
    { ...challenge, ephemeralPublicKeyHex: "00" },
    { ...challenge, signingPublicKeyHex: challenge.signingPublicKeyHex.toUpperCase() },
    { ...challenge, expiresAt: "1800000600" },
    { ...challenge, unexpected: true },
    null,
  ]) expect(() => parseDeviceEnrollmentChallengeWireV1(malformed))
    .toThrow(DeviceEnrollmentProofV1Error);
  for (const malformed of [
    { ...wire, signatureHex: wire.signatureHex.slice(2) },
    { ...wire, nonceHex: "AA".repeat(32) },
    { ...wire, extra: true },
  ]) expect(() => parseDeviceEnrollmentProofWireV1(malformed))
    .toThrow(DeviceEnrollmentProofV1Error);
});
