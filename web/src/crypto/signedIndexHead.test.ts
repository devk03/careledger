import { decodeSignedIndexHead, encodeManagedVaultBlobV2,
  INDEX_HEAD_WIRE_BYTES, MAX_MANAGED_VAULT_WIRE_BYTES,
  IndexHeadWireError } from "@adeno/contracts";

import { encryptManagedVaultBlobV2 } from "./managedVaultV2";
import { generateVaultKeyMaterial, importVaultKey } from "./vault";
import { generateIndexSigningKeys, IndexHeadIntegrityError,
  signLocalIndexHead, verifyIndexHeadCandidate,
  type IndexViewIdentity } from "./signedIndexHead";

const identity: IndexViewIdentity = { householdId: "11".repeat(16),
  careProfileId: "22".repeat(16), viewId: "33".repeat(16),
  indexKeyId: "44".repeat(16), keyEpoch: 1 };
const objectId = "55".repeat(16);
const deviceId = "66".repeat(16);
const grantHead = "77".repeat(32);
const marker = "FICTIONAL_INDEX_NOT_A_REAL_RECORD";

async function ciphertext(value = marker): Promise<Uint8Array> {
  const material = generateVaultKeyMaterial();
  const key = await importVaultKey(material);
  material.fill(0);
  const blob = await encryptManagedVaultBlobV2(key,
    new TextEncoder().encode(value), { householdId: identity.householdId,
      careProfileId: identity.careProfileId, opaqueScopeId: identity.viewId,
      objectId, keyEpoch: identity.keyEpoch, purpose: "encrypted-index",
      revision: 1 });
  return encodeManagedVaultBlobV2(blob);
}

async function fixture() {
  const signingKeys = await generateIndexSigningKeys();
  const firstCiphertext = await ciphertext();
  const first = await signLocalIndexHead({ identity, objectId,
    authorDeviceId: deviceId, authorCounter: 1n, grantHeadSha256: grantHead,
    ciphertextWire: firstCiphertext, signingKeys, previous: null });
  const secondCiphertext = await ciphertext(`${marker}-updated`);
  const second = await signLocalIndexHead({ identity, objectId,
    authorDeviceId: deviceId, authorCounter: 2n, grantHeadSha256: grantHead,
    ciphertextWire: secondCiphertext, signingKeys, previous: first.candidate });
  const verify = (wire: Uint8Array, encrypted: Uint8Array,
    checkpoint = first.candidate) => verifyIndexHeadCandidate({ wire,
      ciphertextWire: encrypted, expectedView: identity,
      trustedSigner: { deviceId, publicKey: signingKeys.publicKey },
      trustedGrantHeadSha256: grantHead, checkpoint });
  return { signingKeys, first, second, firstCiphertext, secondCiphertext, verify };
}

it("signs an opaque view head and advances only from a pinned contiguous checkpoint", async () => {
  const test = await fixture();
  expect(test.signingKeys.privateKey.extractable).toBe(false);
  await expect(crypto.subtle.exportKey("pkcs8", test.signingKeys.privateKey))
    .rejects.toBeDefined();
  const parsed = decodeSignedIndexHead(test.second.wire);
  expect(parsed.context.sequence).toBe(2n);
  expect(parsed.context.previousHeadSha256).toBe(test.first.candidate.headSha256);
  expect(new TextDecoder().decode(test.second.wire)).not.toContain(marker);
  const advanced = await test.verify(test.second.wire, test.secondCiphertext);
  expect(advanced).toEqual({ state: "advanced", candidate: test.second.candidate });
  const unchanged = await test.verify(test.second.wire,
    test.secondCiphertext, test.second.candidate);
  expect(unchanged.state).toBe("unchanged");
});

it("rejects changed ciphertext, signer, grant, view, signature and malformed framing", async () => {
  const test = await fixture();
  const changedWire = test.second.wire.slice();
  changedWire[16] = changedWire[16]! ^ 1;
  const changedSignature = test.second.wire.slice();
  changedSignature[changedSignature.length - 1] =
    changedSignature[changedSignature.length - 1]! ^ 1;
  const changedCiphertext = test.secondCiphertext.slice();
  changedCiphertext[changedCiphertext.length - 1] =
    changedCiphertext[changedCiphertext.length - 1]! ^ 1;
  for (const wire of [changedWire, changedSignature]) {
    await expect(test.verify(wire, test.secondCiphertext))
      .rejects.toBeInstanceOf(IndexHeadIntegrityError);
  }
  await expect(test.verify(test.second.wire, changedCiphertext))
    .rejects.toBeInstanceOf(IndexHeadIntegrityError);
  await expect(verifyIndexHeadCandidate({ wire: test.second.wire,
    ciphertextWire: test.secondCiphertext,
    expectedView: { ...identity, householdId: "aa".repeat(16) },
    trustedSigner: { deviceId, publicKey: test.signingKeys.publicKey },
    trustedGrantHeadSha256: grantHead, checkpoint: test.first.candidate }))
    .rejects.toBeInstanceOf(IndexHeadIntegrityError);
  await expect(verifyIndexHeadCandidate({ wire: test.second.wire,
    ciphertextWire: test.secondCiphertext, expectedView: identity,
    trustedSigner: { deviceId, publicKey: (await generateIndexSigningKeys()).publicKey },
    trustedGrantHeadSha256: grantHead, checkpoint: test.first.candidate }))
    .rejects.toBeInstanceOf(IndexHeadIntegrityError);
  await expect(verifyIndexHeadCandidate({ wire: test.second.wire,
    ciphertextWire: test.secondCiphertext, expectedView: identity,
    trustedSigner: { deviceId, publicKey: test.signingKeys.publicKey },
    trustedGrantHeadSha256: "bb".repeat(32), checkpoint: test.first.candidate }))
    .rejects.toBeInstanceOf(IndexHeadIntegrityError);
  const badVersion = test.second.wire.slice();
  badVersion[4] = 2;
  expect(() => decodeSignedIndexHead(badVersion)).toThrow(IndexHeadWireError);
  expect(() => decodeSignedIndexHead(test.second.wire.subarray(0, -1)))
    .toThrow(IndexHeadWireError);
});

it("rejects rollback, a same-sequence fork, a skipped link, and a fresh device without trust", async () => {
  const test = await fixture();
  await expect(test.verify(test.first.wire, test.firstCiphertext,
    test.second.candidate)).rejects.toBeInstanceOf(IndexHeadIntegrityError);
  const forkCiphertext = await ciphertext(`${marker}-fork`);
  const fork = await signLocalIndexHead({ identity, objectId,
    authorDeviceId: deviceId, authorCounter: 3n, grantHeadSha256: grantHead,
    ciphertextWire: forkCiphertext, signingKeys: test.signingKeys,
    previous: test.first.candidate });
  await expect(test.verify(fork.wire, forkCiphertext,
    test.second.candidate)).rejects.toBeInstanceOf(IndexHeadIntegrityError);
  const thirdCiphertext = await ciphertext(`${marker}-third`);
  const third = await signLocalIndexHead({ identity, objectId,
    authorDeviceId: deviceId, authorCounter: 4n, grantHeadSha256: grantHead,
    ciphertextWire: thirdCiphertext, signingKeys: test.signingKeys,
    previous: test.second.candidate });
  await expect(test.verify(third.wire, thirdCiphertext,
    test.first.candidate)).rejects.toBeInstanceOf(IndexHeadIntegrityError);
  await expect(verifyIndexHeadCandidate({ wire: test.second.wire,
    ciphertextWire: test.secondCiphertext, expectedView: identity,
    trustedSigner: { deviceId, publicKey: test.signingKeys.publicKey },
    trustedGrantHeadSha256: grantHead,
    checkpoint: null as unknown as typeof test.first.candidate }))
    .rejects.toBeInstanceOf(IndexHeadIntegrityError);
});

it("copies mutable network bytes before verifying a candidate", async () => {
  const test = await fixture();
  const wire = test.second.wire.slice();
  const encrypted = test.secondCiphertext.slice();
  const pending = test.verify(wire, encrypted);
  wire.fill(0);
  encrypted.fill(0);
  expect((await pending).candidate).toEqual(test.second.candidate);
});

it("rejects oversized host-controlled bytes before copying them", async () => {
  const test = await fixture();
  await expect(test.verify(new Uint8Array(INDEX_HEAD_WIRE_BYTES + 1),
    test.secondCiphertext)).rejects.toBeInstanceOf(IndexHeadIntegrityError);
  await expect(test.verify(test.second.wire,
    new Uint8Array(MAX_MANAGED_VAULT_WIRE_BYTES + 1)))
    .rejects.toBeInstanceOf(IndexHeadIntegrityError);
});
