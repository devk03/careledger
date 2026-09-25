import { expect, test } from "@playwright/test";

test("Chromium verifies a fictional encrypted-index head from a pinned checkpoint", async ({ page }) => {
  await page.goto("/design-system");
  const result = await page.evaluate(async () => {
    const { generateIndexSigningKeys, signLocalIndexHead,
      verifyIndexHeadCandidate } = await import("/src/crypto/signedIndexHead.ts");
    const { generateVaultKeyMaterial, importVaultKey } =
      await import("/src/crypto/vault.ts");
    const { encryptManagedVaultBlobV2 } =
      await import("/src/crypto/managedVaultV2.ts");
    const { encodeManagedVaultBlobV2 } =
      await import("/src/crypto/managedVaultWireV2.ts");
    const signingKeys = await generateIndexSigningKeys();
    const material = generateVaultKeyMaterial();
    const indexKey = await importVaultKey(material);
    material.fill(0);
    const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
      viewId: "c".repeat(32), indexKeyId: "d".repeat(32), keyEpoch: 1 };
    const objectId = "e".repeat(32);
    const authorDeviceId = "f".repeat(32);
    const grantHead = "12".repeat(32);
    const wire = async (message: string, revision: number) =>
      encodeManagedVaultBlobV2(await encryptManagedVaultBlobV2(indexKey,
        new TextEncoder().encode(message), { householdId: identity.householdId,
          careProfileId: identity.careProfileId, opaqueScopeId: identity.viewId,
          objectId, keyEpoch: 1, purpose: "encrypted-index", revision }));
    const firstCiphertext = await wire("FICTIONAL_INDEX_A", 1);
    const first = await signLocalIndexHead({ identity, objectId,
      authorDeviceId, authorCounter: 1n, grantHeadSha256: grantHead,
      ciphertextWire: firstCiphertext, signingKeys, previous: null });
    const secondCiphertext = await wire("FICTIONAL_INDEX_B", 2);
    const second = await signLocalIndexHead({ identity, objectId,
      authorDeviceId, authorCounter: 2n, grantHeadSha256: grantHead,
      ciphertextWire: secondCiphertext, signingKeys, previous: first.candidate });
    const verified = await verifyIndexHeadCandidate({ wire: second.wire,
      ciphertextWire: secondCiphertext, expectedView: identity,
      trustedSigner: { deviceId: authorDeviceId,
        publicKey: signingKeys.publicKey },
      trustedGrantHeadSha256: grantHead, checkpoint: first.candidate });
    let alteredDenied = false;
    const altered = secondCiphertext.slice();
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    try { await verifyIndexHeadCandidate({ wire: second.wire,
      ciphertextWire: altered, expectedView: identity,
      trustedSigner: { deviceId: authorDeviceId,
        publicKey: signingKeys.publicKey },
      trustedGrantHeadSha256: grantHead, checkpoint: first.candidate }); }
    catch { alteredDenied = true; }
    return { state: verified.state, sequence: String(verified.candidate.sequence),
      alteredDenied, privateExtractable: signingKeys.privateKey.extractable,
      headerContainsPlaintext: new TextDecoder().decode(second.wire)
        .includes("FICTIONAL_INDEX_B") };
  });
  expect(result).toEqual({ state: "advanced", sequence: "2", alteredDenied: true,
    privateExtractable: false, headerContainsPlaintext: false });
});
