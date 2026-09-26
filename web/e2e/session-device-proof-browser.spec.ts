import { expect, test } from "@playwright/test";

test("Chromium signs the fixed fictional device-binding challenge on-device", async ({ page }) => {
  await page.clock.setFixedTime(new Date(1_800_000_000_000));
  await page.goto("/design-system");
  const result = await page.evaluate(async () => {
    const { signSessionDeviceBindingProof } = await import(
      "/src/crypto/sessionDeviceBindingProof.ts");
    const seed = new Uint8Array(32).fill(0x42);
    const pkcs8 = new Uint8Array([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
      0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed,
    ]);
    const publicRaw = Uint8Array.from(
      "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12"
        .match(/../gu)!, pair => Number.parseInt(pair, 16));
    const signingKeys = {
      privateKey: await crypto.subtle.importKey("pkcs8", pkcs8,
        "Ed25519", false, ["sign"]),
      publicKey: await crypto.subtle.importKey("raw", publicRaw,
        "Ed25519", true, ["verify"]),
    };
    const nonce = new Uint8Array(32).fill(0x91);
    const input = {
      householdId: "a1".repeat(16), accountId: "b2".repeat(16),
      sessionId: "c3".repeat(16), deviceId: "d4".repeat(16),
      challengeId: "e5".repeat(16), nonce,
      expiresAt: 1_800_000_300n, signingKeys,
    };
    // The site origin is localhost in this test. Verify that the browser
    // signs that origin, not an audience supplied by the challenge issuer.
    const signed = await signSessionDeviceBindingProof(input);
    const hex = (bytes: Uint8Array) => [...bytes]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    let expiredDenied = false;
    try { await signSessionDeviceBindingProof({ ...input,
      expiresAt: 1_800_000_000n }); }
    catch { expiredDenied = true; }
    return { nonceHash: signed.context.nonceSha256,
      audienceHash: signed.context.audienceSha256,
      origin: location.origin, signature: hex(signed.signature),
      noncePreserved: signed.nonce.every(byte => byte === 0x91),
      privateExtractable: signingKeys.privateKey.extractable,
      expiredDenied };
  });
  expect(result).toEqual({
    nonceHash: "182a7e592cafca805e6ef488103a26ea8900787edfba367e6b5749b7104bc33c",
    audienceHash: "78b686af8a22ab32b094ebca6040e2b76e61d273bc3b3dcffc1de8c604712be9",
    origin: "http://127.0.0.1:4173",
    signature: "cf02d13bb26ef3dd8f8a718fdecb48e17cb8331aa4f5343601957e19fade8e9" +
      "e80010551c35e16e085bf11ef2f2bf1269307c93df8db5bdb899fa69858880e0b",
    noncePreserved: true,
    privateExtractable: false, expiredDenied: true,
  });
});
