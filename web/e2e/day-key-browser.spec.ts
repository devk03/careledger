import { expect, test } from "@playwright/test";

test("Chromium opens only its own synthetic care-day key envelope", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createDayKeyEnvelopes, generateDeviceEncryptionKeys,
      openDayKeyEnvelope } = await import("/src/crypto/dayKeyEnvelope.ts");
    const owner = await generateDeviceEncryptionKeys();
    const outsider = await generateDeviceEncryptionKeys();
    const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
      opaqueDayId: "c".repeat(32), keyEpoch: 1 };
    const recipientDeviceId = "d".repeat(32);
    const { key, envelopes } = await createDayKeyEnvelopes(identity,
      [{ deviceId: recipientDeviceId, publicKey: owner.publicKey }]);
    const scope = { ...identity, recipientDeviceId };
    const opened = await openDayKeyEnvelope(scope, envelopes[0]!, owner);
    let outsiderDenied = false;
    try { await openDayKeyEnvelope(scope, envelopes[0]!, outsider); }
    catch { outsiderDenied = true; }
    let nonExportable = false;
    try { await crypto.subtle.exportKey("raw", opened); }
    catch { nonExportable = true; }
    return { opened: opened.type === "secret", outsiderDenied, nonExportable,
      originalNonExportable: key.extractable === false };
  });
  expect(result).toEqual({ opened: true, outsiderDenied: true, nonExportable: true,
    originalNonExportable: true });
});
