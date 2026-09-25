import { encodeScopeEnvelopeActionPayloadV1,
  encodeScopeKeyEnvelopeV2, SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1 } from
  "@adeno/contracts";
import { expect, it } from "vitest";

import { generateDeviceEncryptionKeys } from "./dayKeyEnvelope";
import { createScopeKeyEnvelopesV2 } from "./scopeKeyEnvelopeV2";
import { generateIndexSigningKeys } from "./signedIndexHead";
import { signScopeEnvelopeAction, SignedScopeEnvelopeActionError } from
  "./signedScopeEnvelopeAction";

const hex = (bytes: Uint8Array) => [...bytes]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function fictionalFixture() {
  const recipient = await generateDeviceEncryptionKeys();
  const signingKeys = await generateIndexSigningKeys();
  const created = await createScopeKeyEnvelopesV2({
    householdId: "aa".repeat(16), careProfileId: "bb".repeat(16),
    opaqueScopeId: "cc".repeat(16), keyId: "dd".repeat(16),
    keyEpoch: 1, purpose: "day",
  }, [{ deviceId: "ee".repeat(16), publicKey: recipient.publicKey }]);
  const envelopeWire = encodeScopeKeyEnvelopeV2(created.envelopes[0]!);
  const recipientEncryptionPublicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", recipient.publicKey));
  return { envelopeWire, recipientEncryptionPublicKey,
    issuerDeviceId: "ff".repeat(16), issuerCounter: 1n,
    sessionId: "12".repeat(16), createdAt: 1_800_000_000n,
    previousActionSha256: null, activeKeyHeadSha256: "11".repeat(32),
    grantHeadSha256: "22".repeat(32), signingKeys };
}

it("signs the exact fictional v2 wire with the enrolled recipient key hash", async () => {
  const input = await fictionalFixture();
  const signed = await signScopeEnvelopeAction(input);
  const payload = encodeScopeEnvelopeActionPayloadV1(signed.context);
  const payloadDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
  expect(signed.payloadSha256).toBe(hex(payloadDigest));
  expect(signed.context.wireSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", input.envelopeWire))));
  expect(await crypto.subtle.verify("Ed25519", input.signingKeys.publicKey,
    signed.signature, payload)).toBe(true);
  const actionMessage = new Uint8Array([
    ...new TextEncoder().encode(SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1),
    ...payload, ...signed.signature,
  ]);
  expect(signed.actionSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", actionMessage))));
});

it("rejects a different recipient key, invalid predecessor and mismatched signer", async () => {
  const input = await fictionalFixture();
  const wrong = await generateDeviceEncryptionKeys();
  const wrongRaw = new Uint8Array(await crypto.subtle.exportKey("raw", wrong.publicKey));
  await expect(signScopeEnvelopeAction({ ...input,
    recipientEncryptionPublicKey: wrongRaw }))
    .rejects.toBeInstanceOf(SignedScopeEnvelopeActionError);
  await expect(signScopeEnvelopeAction({ ...input,
    previousActionSha256: "33".repeat(32) }))
    .rejects.toBeInstanceOf(SignedScopeEnvelopeActionError);
  const other = await generateIndexSigningKeys();
  await expect(signScopeEnvelopeAction({ ...input,
    signingKeys: { privateKey: input.signingKeys.privateKey,
      publicKey: other.publicKey } }))
    .rejects.toBeInstanceOf(SignedScopeEnvelopeActionError);
});

it("snapshots the wire and recipient bytes before asynchronous signing", async () => {
  const input = await fictionalFixture();
  const original = input.envelopeWire.slice();
  const pending = signScopeEnvelopeAction(input);
  input.envelopeWire.fill(0);
  input.recipientEncryptionPublicKey.fill(0);
  input.issuerDeviceId = "00".repeat(16);
  const result = await pending;
  expect(result.context.issuerDeviceId).toBe("ff".repeat(16));
  expect(result.context.wireSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", original))));
});

it("matches the fixed Node Ed25519 interoperability vector", async () => {
  const seed = new Uint8Array(32).fill(0x42);
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
    0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed,
  ]);
  const publicHex =
    "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12";
  const publicRaw = Uint8Array.from(publicHex.match(/../gu)!,
    (pair) => Number.parseInt(pair, 16));
  const signingKeys = {
    privateKey: await crypto.subtle.importKey("pkcs8", pkcs8,
      "Ed25519", false, ["sign"]),
    publicKey: await crypto.subtle.importKey("raw", publicRaw,
      "Ed25519", true, ["verify"]),
  };
  const recipientEncryptionPublicKey = new Uint8Array(32).fill(0x77);
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
  const signed = await signScopeEnvelopeAction({ envelopeWire,
    recipientEncryptionPublicKey, issuerDeviceId: "ff".repeat(16),
    issuerCounter: 2n, sessionId: "12".repeat(16), createdAt: 1_800_000_000n,
    previousActionSha256: "44".repeat(32),
    activeKeyHeadSha256: "22".repeat(32),
    grantHeadSha256: "33".repeat(32), signingKeys });
  expect(signed.payloadSha256)
    .toBe("e94509ee23212d45ade1f3569f07cff3a12624275bd78f16c0a640ea6e389f33");
  expect(hex(signed.signature)).toBe(
    "1c35f3f65fc89928f46aebf74df6bed3ac09dcefccef9ded7e54c33d5a783d4" +
    "e428cfaa3e5a0087f253b6e40a077473deed93f739db83106877fbecd73a9860d");
  expect(signed.actionSha256)
    .toBe("5eb17a3c1e4b024cafc24a3d5ac741be8b9926a5d57055ae9b88e970cd776444");
});
