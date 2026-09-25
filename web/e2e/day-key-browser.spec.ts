import { expect, test } from "@playwright/test";

test("Chromium opens only its own synthetic care-day key envelope", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createDayKeyEnvelopes, generateDeviceEncryptionKeys,
      openDayKeyEnvelope } = await import("/src/crypto/dayKeyEnvelope.ts");
    const { encodeDayKeyEnvelope, decodeDayKeyEnvelope } =
      await import("/src/crypto/dayKeyEnvelopeWire.ts");
    const owner = await generateDeviceEncryptionKeys();
    const outsider = await generateDeviceEncryptionKeys();
    const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
      opaqueDayId: "c".repeat(32), keyEpoch: 1 };
    const recipientDeviceId = "d".repeat(32);
    const { key, envelopes } = await createDayKeyEnvelopes(identity,
      [{ deviceId: recipientDeviceId, publicKey: owner.publicKey }]);
    const scope = { ...identity, recipientDeviceId };
    const wire = encodeDayKeyEnvelope(envelopes[0]!);
    const decoded = decodeDayKeyEnvelope(wire);
    const opened = await openDayKeyEnvelope(scope, decoded, owner);
    let outsiderDenied = false;
    try { await openDayKeyEnvelope(scope, decoded, outsider); }
    catch { outsiderDenied = true; }
    let nonExportable = false;
    try { await crypto.subtle.exportKey("raw", opened); }
    catch { nonExportable = true; }
    return { opened: opened.type === "secret", outsiderDenied, nonExportable,
      fixedWire: wire.byteLength === 188,
      originalNonExportable: key.extractable === false };
  });
  expect(result).toEqual({ opened: true, outsiderDenied: true, nonExportable: true,
    fixedWire: true,
    originalNonExportable: true });
});

test("Chromium binds a fictional encrypted day snapshot to its key and opaque scope", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createDayKeyEnvelopes, generateDeviceEncryptionKeys,
      openDayKeyEnvelope } = await import("/src/crypto/dayKeyEnvelope.ts");
    const { encryptManagedVaultBlobV2, decryptManagedVaultBlobV2 } =
      await import("/src/crypto/managedVaultV2.ts");
    const { encodeManagedVaultBlobV2, decodeManagedVaultBlobV2 } =
      await import("/src/crypto/managedVaultWireV2.ts");
    const device = await generateDeviceEncryptionKeys();
    const outsider = await generateDeviceEncryptionKeys();
    const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
      opaqueDayId: "c".repeat(32), keyEpoch: 1 };
    const recipientDeviceId = "d".repeat(32);
    const { envelopes } = await createDayKeyEnvelopes(identity,
      [{ deviceId: recipientDeviceId, publicKey: device.publicKey }]);
    const key = await openDayKeyEnvelope({ ...identity, recipientDeviceId },
      envelopes[0]!, device);
    const scope = { householdId: identity.householdId,
      careProfileId: identity.careProfileId, opaqueScopeId: identity.opaqueDayId,
      objectId: "e".repeat(32), keyEpoch: identity.keyEpoch,
      purpose: "day-snapshot" as const, revision: 1 };
    const marker = "FICTIONAL_DAY_SNAPSHOT_NOT_A_REAL_RECORD";
    const blob = await encryptManagedVaultBlobV2(key, new TextEncoder().encode(marker), scope);
    const wire = encodeManagedVaultBlobV2(blob);
    const opened = await decryptManagedVaultBlobV2(key, decodeManagedVaultBlobV2(wire), scope);
    let wrongDayDenied = false;
    try { await decryptManagedVaultBlobV2(key, blob,
      { ...scope, opaqueScopeId: "f".repeat(32) }); }
    catch { wrongDayDenied = true; }
    let outsiderDenied = false;
    try { await openDayKeyEnvelope({ ...identity, recipientDeviceId },
      envelopes[0]!, outsider); }
    catch { outsiderDenied = true; }
    return { opened: new TextDecoder().decode(opened) === marker,
      wireVersion: wire[4], plaintextOnWire: new TextDecoder().decode(wire).includes(marker),
      wrongDayDenied, outsiderDenied };
  });
  expect(result).toEqual({ opened: true, wireVersion: 2, plaintextOnWire: false,
    wrongDayDenied: true, outsiderDenied: true });
});
