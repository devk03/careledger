import { encodeScopeEnvelopeActionPayloadV1,
  encodeScopeEnvelopeBackfillPayloadV1, encodeScopeKeyEnvelopeV2,
  SCOPE_ENVELOPE_BACKFILL_PAYLOAD_BYTES_V1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { signScopeEnvelopeBackfill,
  SignedScopeEnvelopeBackfillError } from "./signedScopeEnvelopeBackfill";

const fromHex = (value: string) => Uint8Array.from(value.match(/../gu)!,
  (pair) => Number.parseInt(pair, 16));
const hex = (bytes: Uint8Array) => [...bytes]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function fictionalVector() {
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
    0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ...new Uint8Array(32).fill(0x42),
  ]);
  const signingKeys = {
    privateKey: await crypto.subtle.importKey("pkcs8", pkcs8,
      "Ed25519", false, ["sign"]),
    publicKey: await crypto.subtle.importKey("raw", fromHex(
      "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12"),
    "Ed25519", true, ["verify"]),
  };
  const envelopeWire = encodeScopeKeyEnvelopeV2({
    format: "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2",
    context: { householdId: "aa".repeat(16), careProfileId: "bb".repeat(16),
      opaqueScopeId: "cc".repeat(16), keyId: "dd".repeat(16),
      keyEpoch: 3, purpose: "source", recipientDeviceId: "ee".repeat(16) },
    keyCommitmentSha256: "11".repeat(32),
    recipientKeySha256:
      "e29442e61ad354e5cb0831e2e8359e8fb50cf024ad5a8f407c8f9de63bdf7371",
    encapsulatedKey: new Uint8Array(32).fill(4),
    ciphertext: new Uint8Array(48).fill(5).buffer,
  });
  return { envelopeWire,
    recipientEncryptionPublicKey: new Uint8Array(32).fill(0x77),
    historicalActivationSequence: 3n,
    historicalActivationSha256: "66".repeat(32),
    currentActiveKeySequence: 4n,
    currentActiveKeyHeadSha256: "22".repeat(32),
    currentGrantSequence: 2n,
    currentGrantHeadSha256: "33".repeat(32),
    issuerDeviceId: "ff".repeat(16), issuerCounter: 2n,
    sessionId: "12".repeat(16), createdAt: 1_800_000_000n,
    previousActionSha256: "44".repeat(32), signingKeys };
}

it("matches the fixed Node historical-backfill signature vector", async () => {
  const input = await fictionalVector();
  const signed = await signScopeEnvelopeBackfill(input);
  const payload = encodeScopeEnvelopeBackfillPayloadV1(signed.context);
  expect(payload.byteLength).toBe(SCOPE_ENVELOPE_BACKFILL_PAYLOAD_BYTES_V1);
  expect(hex(payload.subarray(0, 8))).toBe("4144484201010201");
  expect(signed.payloadSha256)
    .toBe("48b19dae5e2da358f43900527561076bae28cd97c55733caa8d26fed5827320e");
  expect(hex(signed.signature)).toBe(
    "4c39a664a45081b01197728580f59170f8f3483f2523b5e7630377d626cf10b" +
    "06f833f83efaeab0888485388ed39e2530f319746221255b874ab81779890460c");
  expect(signed.actionSha256)
    .toBe("75244649b176653d6cccb655a1144fbb6fb28ff8045c9d1ca917084e4f214d92");
  const backfill = signed.context;
  const ordinaryContext = {
    householdId: backfill.householdId,
    careProfileId: backfill.careProfileId,
    opaqueScopeId: backfill.opaqueScopeId,
    keyId: backfill.keyId,
    keyEpoch: backfill.keyEpoch,
    purpose: backfill.purpose,
    recipientDeviceId: backfill.recipientDeviceId,
    keyCommitmentSha256: backfill.keyCommitmentSha256,
    recipientKeySha256: backfill.recipientKeySha256,
    wireSha256: backfill.wireSha256,
    activeKeyHeadSha256: backfill.activeKeyHeadSha256,
    grantHeadSha256: backfill.grantHeadSha256,
    issuerDeviceId: backfill.issuerDeviceId,
    issuerCounter: backfill.issuerCounter,
    sessionId: backfill.sessionId,
    createdAt: backfill.createdAt,
    previousActionSha256: backfill.previousActionSha256,
    issuerSigningKeySha256: backfill.issuerSigningKeySha256,
  };
  const ordinaryPayload = encodeScopeEnvelopeActionPayloadV1(ordinaryContext);
  expect(await crypto.subtle.verify("Ed25519", input.signingKeys.publicKey,
    signed.signature, ordinaryPayload)).toBe(false);
});

it("rejects a mismatched recipient and stale or missing historical sequence", async () => {
  const input = await fictionalVector();
  await expect(signScopeEnvelopeBackfill({ ...input,
    recipientEncryptionPublicKey: new Uint8Array(32).fill(1) }))
    .rejects.toBeInstanceOf(SignedScopeEnvelopeBackfillError);
  await expect(signScopeEnvelopeBackfill({ ...input,
    currentActiveKeySequence: 3n }))
    .rejects.toBeInstanceOf(SignedScopeEnvelopeBackfillError);
  await expect(signScopeEnvelopeBackfill({ ...input,
    historicalActivationSequence: 0n }))
    .rejects.toBeInstanceOf(SignedScopeEnvelopeBackfillError);
});

it("signs an immutable snapshot despite caller edits during WebCrypto awaits", async () => {
  const input = await fictionalVector();
  const pending = signScopeEnvelopeBackfill(input);
  input.envelopeWire.fill(0);
  input.recipientEncryptionPublicKey.fill(0);
  input.currentActiveKeyHeadSha256 = "00".repeat(32);
  input.historicalActivationSequence = 1n;
  const signed = await pending;
  expect(signed.context.activeKeyHeadSha256).toBe("22".repeat(32));
  expect(signed.context.historicalActivationSequence).toBe(3n);
  expect(signed.payloadSha256)
    .toBe("48b19dae5e2da358f43900527561076bae28cd97c55733caa8d26fed5827320e");
});
