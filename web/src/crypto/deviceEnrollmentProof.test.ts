import { createHash } from "node:crypto";

import { encodeDeviceEnrollmentChallengeWireV1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { BrowserDeviceEnrollmentProofError,
  candidateDeviceApprovalCode, generateProposedDeviceKeys,
  proposedDevicePublicKeys } from "./deviceEnrollmentProof";

const id = (byte: string) => byte.repeat(32);

it("computes the human comparison code from locally held keys, not server-only claims", async () => {
  const keys = await generateProposedDeviceKeys();
  const local = await proposedDevicePublicKeys(keys);
  const wire = encodeDeviceEnrollmentChallengeWireV1({
    householdId: id("1"), accountId: id("2"), sessionId: id("3"),
    challengeId: id("4"), ephemeralPublicKey: new Uint8Array(32).fill(9),
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 300),
    encryptionPublicKey: Uint8Array.from(Buffer.from(
      local.encryptionPublicKeyHex, "hex")),
    signingPublicKey: Uint8Array.from(Buffer.from(
      local.signingPublicKeyHex, "hex")),
  });
  const expectedMaterial = Buffer.concat([
    Buffer.from("adeno:managed:device-approval:v1\0", "utf8"),
    Buffer.from(wire.householdId, "hex"), Buffer.from(wire.accountId, "hex"),
    Buffer.from(wire.challengeId, "hex"),
    Buffer.from(local.encryptionPublicKeyHex, "hex"),
    Buffer.from(local.signingPublicKeyHex, "hex"),
  ]);
  const prefix = createHash("sha256").update(expectedMaterial)
    .digest("hex").slice(0, 12);
  const expectedCode = `${prefix.slice(0, 4)}-${prefix.slice(4, 8)}-${prefix.slice(8)}`;
  expect(await candidateDeviceApprovalCode(wire, keys)).toBe(expectedCode);
  await expect(candidateDeviceApprovalCode({ ...wire,
    signingPublicKeyHex: "00".repeat(32) }, keys))
    .rejects.toBeInstanceOf(BrowserDeviceEnrollmentProofError);
  await expect(candidateDeviceApprovalCode(wire,
    await generateProposedDeviceKeys()))
    .rejects.toBeInstanceOf(BrowserDeviceEnrollmentProofError);
  await expect(candidateDeviceApprovalCode({ ...wire,
    expiresAt: Math.floor(Date.now() / 1000) - 1 }, keys))
    .rejects.toBeInstanceOf(BrowserDeviceEnrollmentProofError);
});
