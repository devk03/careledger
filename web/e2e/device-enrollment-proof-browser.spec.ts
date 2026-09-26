import { createHash, createPrivateKey, createPublicKey,
  diffieHellman, verify } from "node:crypto";

import { encodeDeviceEnrollmentNonceMaterialV1,
  encodeDeviceEnrollmentProofV1 } from "@adeno/contracts";
import { expect, test } from "@playwright/test";

test("Chromium signs only its own fictional enrollment keys and origin", async ({ page }) => {
  await page.clock.setFixedTime(new Date(1_800_000_000_000));
  await page.goto("/design-system");
  const result = await page.evaluate(async () => {
    const { generateProposedDeviceKeys, proposedDevicePublicKeys,
      signDeviceEnrollmentChallengeWire } = await import(
      "/src/crypto/deviceEnrollmentProof.ts");
    const keys = await generateProposedDeviceKeys();
    const publicKeys = await proposedDevicePublicKeys(keys);
    const ephemeral = await crypto.subtle.generateKey("X25519", true,
      ["deriveBits"]);
    const hex = (bytes: Uint8Array) => [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const ephemeralPublicKeyHex = hex(new Uint8Array(
      await crypto.subtle.exportKey("raw", ephemeral.publicKey)));
    const ephemeralPrivatePkcs8Hex = hex(new Uint8Array(
      await crypto.subtle.exportKey("pkcs8", ephemeral.privateKey)));
    const challenge = {
      format: "adeno:device-enrollment-challenge:v1",
      householdId: "a1".repeat(16), accountId: "b2".repeat(16),
      sessionId: "c3".repeat(16), challengeId: "d4".repeat(16),
      ephemeralPublicKeyHex, expiresAt: 1_800_000_300,
      ...publicKeys,
    };
    const proof = await signDeviceEnrollmentChallengeWire(challenge, keys);
    const wrongKeyDenied = await signDeviceEnrollmentChallengeWire({
      ...challenge, encryptionPublicKeyHex: "11".repeat(32),
    }, keys).then(() => false, () => true);
    const expiredDenied = await signDeviceEnrollmentChallengeWire({
      ...challenge, expiresAt: 1_799_999_939,
    }, keys).then(() => false, () => true);
    const extraFieldDenied = await signDeviceEnrollmentChallengeWire({
      ...challenge, extra: true,
    }, keys).then(() => false, () => true);
    const lowOrderDenied = await signDeviceEnrollmentChallengeWire({
      ...challenge, ephemeralPublicKeyHex: "00".repeat(32),
    }, keys).then(() => false, () => true);
    return { challenge, proof, ephemeralPrivatePkcs8Hex,
      origin: location.origin,
      encryptionPrivateExtractable: keys.encryptionKeys.privateKey.extractable,
      signingPrivateExtractable: keys.signingKeys.privateKey.extractable,
      wrongKeyDenied, expiredDenied, extraFieldDenied, lowOrderDenied };
  });
  expect(result.encryptionPrivateExtractable).toBe(false);
  expect(result.signingPrivateExtractable).toBe(false);
  expect(result.wrongKeyDenied).toBe(true);
  expect(result.expiredDenied).toBe(true);
  expect(result.extraFieldDenied).toBe(true);
  expect(result.lowOrderDenied).toBe(true);
  expect(result.proof.format).toBe("adeno:device-enrollment-proof:v1");
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const ephemeralPrivateKey = createPrivateKey({ key: Buffer.from(
    result.ephemeralPrivatePkcs8Hex, "hex"), format: "der", type: "pkcs8" });
  const proposedEncryptionPublicKey = createPublicKey({ key: Buffer.concat([
    Buffer.from("302a300506032b656e032100", "hex"),
    Buffer.from(result.challenge.encryptionPublicKeyHex, "hex"),
  ]), format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey: ephemeralPrivateKey,
    publicKey: proposedEncryptionPublicKey });
  const audienceSha256 = hash(Buffer.from(result.origin));
  const material = encodeDeviceEnrollmentNonceMaterialV1({
    sharedSecret: shared, challengeId: result.challenge.challengeId,
    audienceSha256,
  });
  expect(result.proof.nonceHex).toBe(hash(Buffer.from(material)));
  const payload = encodeDeviceEnrollmentProofV1({
    householdId: result.challenge.householdId,
    accountId: result.challenge.accountId,
    sessionId: result.challenge.sessionId,
    challengeId: result.challenge.challengeId,
    nonceSha256: hash(Buffer.from(result.proof.nonceHex, "hex")),
    audienceSha256,
    encryptionPublicKeyHex: result.challenge.encryptionPublicKeyHex,
    signingPublicKeyHex: result.challenge.signingPublicKeyHex,
    expiresAt: BigInt(result.challenge.expiresAt),
  });
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(result.challenge.signingPublicKeyHex, "hex"),
  ]), format: "der", type: "spki" });
  expect(verify(null, Buffer.from(payload), key,
    Buffer.from(result.proof.signatureHex, "hex"))).toBe(true);
});
