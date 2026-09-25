import { decodeDayKeyEnvelope, DayKeyEnvelopeWireError,
  decodeScopeKeyEnvelopeV2, encodeScopeKeyEnvelopeV2,
  ScopeKeyEnvelopeWireV2Error } from "@adeno/contracts";
import { expect, it } from "vitest";

import { generateDeviceEncryptionKeys } from "./dayKeyEnvelope";
import { decryptManagedVaultBlobV2, encryptManagedVaultBlobV2 } from
  "./managedVaultV2";
import { createScopeKeyEnvelopesV2, openScopeKeyEnvelopeV2,
  scopeKeyCommitmentSha256,
  ScopeKeyEnvelopeV2Error, type ScopeKeyIdentityV2,
  type ScopeKeyEnvelopeV2 } from "./scopeKeyEnvelopeV2";

const identity: ScopeKeyIdentityV2 = {
  householdId: "aa".repeat(16), careProfileId: "bb".repeat(16),
  opaqueScopeId: "cc".repeat(16), keyId: "dd".repeat(16),
  keyEpoch: 1, purpose: "draft",
};
const recipientDeviceId = "ee".repeat(16);
const expectedHex = "41444b5902010000" + "aa".repeat(16) +
  "bb".repeat(16) + "cc".repeat(16) + "dd".repeat(16) + "ee".repeat(16) +
  "00000001" + "03000000" + "ff".repeat(32) + "99".repeat(32) +
  "11".repeat(32) + "22".repeat(48);
const scope = { householdId: identity.householdId,
  careProfileId: identity.careProfileId,
  opaqueScopeId: identity.opaqueScopeId, objectId: "ab".repeat(16),
  keyEpoch: 1, purpose: "review-draft" as const, revision: 1 };

const hex = (bytes: Uint8Array) => [...bytes]
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function fixture(purpose: ScopeKeyIdentityV2["purpose"] = "draft") {
  const recipient = await generateDeviceEncryptionKeys();
  const selected = { ...identity, purpose };
  const created = await createScopeKeyEnvelopesV2(selected,
    [{ deviceId: recipientDeviceId, publicKey: recipient.publicKey }]);
  return { recipient, selected, ...created, envelope: created.envelopes[0]! };
}

it("pins one exact 240-byte purpose-bound structural wire", () => {
  const wire = encodeScopeKeyEnvelopeV2({
    format: "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2",
    context: { ...identity, recipientDeviceId },
    keyCommitmentSha256: "ff".repeat(32),
    recipientKeySha256: "99".repeat(32),
    encapsulatedKey: new Uint8Array(32).fill(0x11),
    ciphertext: new Uint8Array(48).fill(0x22).buffer,
  });
  expect(wire.byteLength).toBe(240);
  expect(hex(wire)).toBe(expectedHex);
  expect(encodeScopeKeyEnvelopeV2(decodeScopeKeyEnvelopeV2(wire))).toEqual(wire);
});

it("pins the material-only key commitment domain and snapshots its input", async () => {
  const material = new Uint8Array(32).fill(1);
  const pending = scopeKeyCommitmentSha256(material);
  material.fill(0);
  expect(await pending).toBe(
    "92c17e6a0dea261bbb115098dc6d85541cc00e0edaabb98159c51c499e3cbdd1");
});

it.each(["day", "source", "draft", "index"] as const)(
  "opens only the %s scope key with the matching recipient key pair", async (purpose) => {
    const test = await fixture(purpose);
    const expected = { ...test.selected, recipientDeviceId,
      keyCommitmentSha256: test.keyCommitmentSha256 };
    const wire = encodeScopeKeyEnvelopeV2(test.envelope);
    const opened = await openScopeKeyEnvelopeV2(expected,
      decodeScopeKeyEnvelopeV2(wire), test.recipient);
    expect(opened.extractable).toBe(false);
    const contentScope = { ...scope,
      purpose: purpose === "day" ? "day-snapshot" as const :
        purpose === "source" ? "source-original" as const :
          purpose === "draft" ? "review-draft" as const :
            "encrypted-index" as const };
    const plain = new TextEncoder().encode("FICTIONAL_SCOPE_KEY_TEST_NOT_A_RECORD");
    const encrypted = await encryptManagedVaultBlobV2(test.key, plain, contentScope);
    expect([...(await decryptManagedVaultBlobV2(opened, encrypted, contentScope))])
      .toEqual([...plain]);
    expect(new TextDecoder().decode(wire)).not.toContain("FICTIONAL_SCOPE_KEY_TEST");
  });

it("rejects wrong purpose, scope, key identity, epoch, commitment and recipient", async () => {
  const test = await fixture();
  const expected = { ...test.selected, recipientDeviceId,
    keyCommitmentSha256: test.keyCommitmentSha256 };
  for (const change of [
    { purpose: "source" as const }, { opaqueScopeId: "ff".repeat(16) },
    { keyId: "ff".repeat(16) }, { keyEpoch: 2 },
    { careProfileId: "ff".repeat(16) },
    { householdId: "ff".repeat(16) },
    { recipientDeviceId: "ff".repeat(16) },
    { keyCommitmentSha256: "00".repeat(32) },
  ]) {
    await expect(openScopeKeyEnvelopeV2({ ...expected, ...change },
      test.envelope, test.recipient)).rejects.toBeInstanceOf(ScopeKeyEnvelopeV2Error);
  }
  await expect(openScopeKeyEnvelopeV2(expected, test.envelope,
    await generateDeviceEncryptionKeys())).rejects.toBeInstanceOf(ScopeKeyEnvelopeV2Error);
});

it("rejects v1, noncanonical lengths, reserved bytes and tampered authentication", async () => {
  const test = await fixture();
  const expected = { ...test.selected, recipientDeviceId,
    keyCommitmentSha256: test.keyCommitmentSha256 };
  const wire = encodeScopeKeyEnvelopeV2(test.envelope);
  expect(() => decodeDayKeyEnvelope(wire)).toThrow(DayKeyEnvelopeWireError);
  for (const length of [0, 1, 191, 239]) {
    expect(() => decodeScopeKeyEnvelopeV2(wire.subarray(0, length)))
      .toThrow(ScopeKeyEnvelopeWireV2Error);
  }
  expect(() => decodeScopeKeyEnvelopeV2(new Uint8Array([...wire, 0])))
    .toThrow(ScopeKeyEnvelopeWireV2Error);
  for (const offset of [4, 5, 6, 7, 93, 94, 95]) {
    const changed = wire.slice();
    changed[offset]! ^= 1;
    expect(() => decodeScopeKeyEnvelopeV2(changed))
      .toThrow(ScopeKeyEnvelopeWireV2Error);
  }
  for (const offset of [8, 40, 72, 92, 96, 128, 160, 239]) {
    const changed = wire.slice();
    changed[offset]! ^= 1;
    const decoded = decodeScopeKeyEnvelopeV2(changed);
    await expect(openScopeKeyEnvelopeV2(expected, decoded, test.recipient))
      .rejects.toBeInstanceOf(ScopeKeyEnvelopeV2Error);
  }
});

it("rejects spoofed byte brands instead of encoding silent zero fields", async () => {
  const test = await fixture();
  const fakeCiphertext = { byteLength: 48,
    [Symbol.toStringTag]: "ArrayBuffer" };
  const fakeEncapsulation = new DataView(new ArrayBuffer(32));
  Object.defineProperty(fakeEncapsulation, Symbol.toStringTag,
    { value: "Uint8Array" });
  expect(() => encodeScopeKeyEnvelopeV2({ ...test.envelope,
    ciphertext: fakeCiphertext as ArrayBuffer }))
    .toThrow(ScopeKeyEnvelopeWireV2Error);
  expect(() => encodeScopeKeyEnvelopeV2({ ...test.envelope,
    encapsulatedKey: fakeEncapsulation as unknown as Uint8Array }))
    .toThrow(ScopeKeyEnvelopeWireV2Error);
  const fakeDigest = { toString: () => "aa".repeat(32), length: 0 };
  expect(() => encodeScopeKeyEnvelopeV2({ ...test.envelope,
    keyCommitmentSha256: fakeDigest as unknown as string }))
    .toThrow(ScopeKeyEnvelopeWireV2Error);
  expect(() => encodeScopeKeyEnvelopeV2({ ...test.envelope,
    recipientKeySha256: fakeDigest as unknown as string }))
    .toThrow(ScopeKeyEnvelopeWireV2Error);
});

it("copies the caller's identity, recipients and envelope before awaits", async () => {
  const recipient = await generateDeviceEncryptionKeys();
  const mutable = { ...identity };
  const selected = { deviceId: recipientDeviceId, publicKey: recipient.publicKey };
  const creating = createScopeKeyEnvelopesV2(mutable, [selected]);
  mutable.opaqueScopeId = "ff".repeat(16);
  selected.deviceId = "ff".repeat(16);
  const result = await creating;
  const envelope = result.envelopes[0]!;
  const expected = { ...identity, recipientDeviceId,
    keyCommitmentSha256: result.keyCommitmentSha256 };
  const copy: ScopeKeyEnvelopeV2 = { ...envelope,
    context: { ...envelope.context },
    encapsulatedKey: envelope.encapsulatedKey.slice(),
    ciphertext: envelope.ciphertext.slice(0) };
  const mutableRecipient = { ...recipient };
  const opening = openScopeKeyEnvelopeV2(expected, copy, mutableRecipient);
  expected.keyCommitmentSha256 = "00".repeat(32);
  mutableRecipient.publicKey = (await generateDeviceEncryptionKeys()).publicKey;
  copy.context.keyId = "ff".repeat(16);
  copy.encapsulatedKey.fill(0);
  new Uint8Array(copy.ciphertext).fill(0);
  await expect(opening).resolves.toBeDefined();
});

it("rejects malformed recipient entries with one envelope error type", async () => {
  for (const recipients of [[null], [42], [undefined]] as unknown[][]) {
    await expect(createScopeKeyEnvelopesV2(identity, recipients as never))
      .rejects.toBeInstanceOf(ScopeKeyEnvelopeV2Error);
  }
});
