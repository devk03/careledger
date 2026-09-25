import { expect, test } from "@playwright/test";

test("fictional vault bytes encrypt and decrypt in a real browser", async ({ page }) => {
  await page.goto("/design-system");
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

test("fictional recovery kit opens an encrypted record in a fresh browser", async ({
  page, browser,
}) => {
  await page.goto("/design-system");
  const kit = await page.evaluate(async () => {
    const recovery = await import(/* @vite-ignore */ "/src/crypto/recovery.ts");
    const recoveryWire = await import(/* @vite-ignore */
      "/src/crypto/recoveryEnvelopeWire.ts");
    const vault = await import(/* @vite-ignore */ "/src/crypto/vault.ts");
    const blobWire = await import(/* @vite-ignore */ "/src/crypto/vaultWire.ts");
    const householdId = "fictional-family-a";
    const scope = { householdId, objectId: "opaque-recovery-item", revision: 1 };
    const created = await recovery.createRecoverableVault(householdId);
    const plaintext = new TextEncoder().encode("FICTIONAL_RECOVERY_MARKER_NOT_A_REAL_RECORD");
    const encrypted = await vault.encryptVaultBlob(created.key, plaintext, scope);
    return { code: created.recoveryCode,
      envelope: [...recoveryWire.encodeRecoveryEnvelope(created.envelope)],
      record: [...blobWire.encodeVaultBlob(encrypted)] };
  });
  const context = await browser.newContext();
  try {
    const freshPage = await context.newPage();
    await freshPage.goto("/design-system");
    const result = await freshPage.evaluate(async ({ code, envelope, record }) => {
      const recovery = await import(/* @vite-ignore */ "/src/crypto/recovery.ts");
      const recoveryWire = await import(/* @vite-ignore */
        "/src/crypto/recoveryEnvelopeWire.ts");
      const vault = await import(/* @vite-ignore */ "/src/crypto/vault.ts");
      const blobWire = await import(/* @vite-ignore */ "/src/crypto/vaultWire.ts");
      const key = await recovery.recoverVault(code, "fictional-family-a",
        recoveryWire.decodeRecoveryEnvelope(new Uint8Array(envelope)));
      const bytes = await vault.decryptVaultBlob(key,
        blobWire.decodeVaultBlob(new Uint8Array(record)),
        { householdId: "fictional-family-a", objectId: "opaque-recovery-item", revision: 1 });
      return { marker: new TextDecoder().decode(bytes), nonExtractable: key.extractable === false };
    }, kit);
    expect(result).toEqual({ marker: "FICTIONAL_RECOVERY_MARKER_NOT_A_REAL_RECORD",
      nonExtractable: true });
  } finally {
    await context.close();
  }
});
