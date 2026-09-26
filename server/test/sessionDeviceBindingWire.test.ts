import { encodeSessionDeviceChallengeWireV1,
  encodeSessionDeviceProofWireV1, parseSessionDeviceChallengeWireV1,
  parseSessionDeviceProofWireV1, SessionDeviceBindingWireV1Error } from
  "@adeno/contracts";
import { expect, it } from "vitest";

const challenge = {
  householdId: "a1".repeat(16), accountId: "b2".repeat(16),
  sessionId: "c3".repeat(16), deviceId: "d4".repeat(16),
  challengeId: "e5".repeat(16), nonce: new Uint8Array(32).fill(0x91),
  expiresAt: 1_800_000_300n,
};

it("round-trips an invented challenge and proof through ordinary JSON", () => {
  const issued = encodeSessionDeviceChallengeWireV1(challenge);
  const parsed = parseSessionDeviceChallengeWireV1(
    JSON.parse(JSON.stringify(issued)) as unknown);
  expect(parsed).toEqual(challenge);
  const signature = new Uint8Array(64).fill(0xab);
  const proof = encodeSessionDeviceProofWireV1({ challengeId: parsed.challengeId,
    nonce: parsed.nonce, signature });
  expect(parseSessionDeviceProofWireV1(
    JSON.parse(JSON.stringify(proof)) as unknown)).toEqual({
    challengeId: challenge.challengeId, nonce: challenge.nonce, signature });
  expect(JSON.stringify(issued)).not.toContain("1800000300n");
  expect(JSON.stringify(proof)).not.toContain("Uint8Array");
});

it("rejects malformed or ambiguous JSON before signing or database binding", () => {
  const issued = encodeSessionDeviceChallengeWireV1(challenge);
  class ChallengeInstance {
    constructor() { Object.assign(this, issued); }
  }
  const accessor = { ...issued };
  Object.defineProperty(accessor, "nonceHex", {
    enumerable: true, get() { throw new Error("getter must not run"); },
  });
  const throwingProxy = new Proxy({ ...issued }, {
    ownKeys() { throw new Error("proxy trap"); },
  });
  const malformedChallenges: unknown[] = [
    { ...issued, householdId: issued.householdId.toUpperCase() },
    { ...issued, nonceHex: issued.nonceHex.slice(2) },
    { ...issued, expiresAt: "1800000300" },
    { ...issued, expiresAt: 1.5 },
    { ...issued, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...issued, expiresAt: Number.NaN },
    { ...issued, expiresAt: Number.POSITIVE_INFINITY },
    { ...issued, expiresAt: 0 },
    { ...issued, expiresAt: -1 },
    { ...issued, unexpected: "field" },
    { ...issued, format: "adeno:session-device-challenge:v2" },
    new ChallengeInstance(), accessor, throwingProxy,
    null, true, [],
  ];
  for (const malformed of malformedChallenges)
    expect(() => parseSessionDeviceChallengeWireV1(malformed))
      .toThrow(SessionDeviceBindingWireV1Error);
  const proof = encodeSessionDeviceProofWireV1({
    challengeId: challenge.challengeId, nonce: challenge.nonce,
    signature: new Uint8Array(64).fill(0xab),
  });
  for (const malformed of [
    { ...proof, challengeId: proof.challengeId.toUpperCase() },
    { ...proof, signatureHex: proof.signatureHex.slice(2) },
    { ...proof, signatureHex: proof.signatureHex.toUpperCase() },
    { ...proof, nonceHex: proof.nonceHex.slice(2) },
    { ...proof, unexpected: true },
    null, false, [],
  ]) expect(() => parseSessionDeviceProofWireV1(malformed))
    .toThrow(SessionDeviceBindingWireV1Error);
});
