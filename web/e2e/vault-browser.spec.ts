import { expect, test } from "@playwright/test";

test("fictional vault bytes encrypt and decrypt in a real browser", async ({ page }) => {
  await page.goto("/");
  const outcome = await page.evaluate(async () => {
    const vaultPath = "/src/crypto/vault.ts";
    const wirePath = "/src/crypto/vaultWire.ts";
    const vault = await import(/* @vite-ignore */ vaultPath);
    const wireFormat = await import(/* @vite-ignore */ wirePath);
    const marker = "FICTIONAL_BROWSER_MARKER_NOT_A_REAL_RECORD";
    const plaintext = new TextEncoder().encode(marker);
    const material = vault.generateVaultKeyMaterial();
    const key = await vault.importVaultKey(material);
    material.fill(0);
    const scope = { householdId: "fictional-family-a", objectId: "opaque-browser-item",
      revision: 1 };
    const encrypted = await vault.encryptVaultBlob(key, plaintext, scope);
    const encoded = wireFormat.encodeVaultBlob(encrypted);
    const decoded = wireFormat.decodeVaultBlob(encoded);
    const restored = await vault.decryptVaultBlob(key, decoded, scope);
    let wrongScopeRejected = false;
    try {
      await vault.decryptVaultBlob(key, decoded, { ...scope, revision: 2 });
    } catch {
      wrongScopeRejected = true;
    }
    return {
      roundTrip: new TextDecoder().decode(restored) === marker,
      wireContainsPlaintext: new TextDecoder().decode(encoded).includes(marker),
      nonExtractable: key.extractable === false,
      wrongScopeRejected,
    };
  });
  expect(outcome).toEqual({ roundTrip: true, wireContainsPlaintext: false,
    nonExtractable: true, wrongScopeRejected: true });
});
