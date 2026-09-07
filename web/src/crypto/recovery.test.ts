import { expect, it } from "vitest";

import { decryptVaultBlob, encryptVaultBlob } from "./vault";
import {
  RECOVERY_KDF_PROFILE,
  RecoveryError,
  createRecoverableVault,
  recoverVault,
} from "./recovery";

const scope = {
  householdId: "synthetic-household",
  objectId: "synthetic-object",
  revision: 1,
};

it("generates a checksummed high-entropy kit and wraps the key before returning", async () => {
  const recoverable = await createRecoverableVault("synthetic-household");
  expect(recoverable.envelope.kdfProfile).toBe(RECOVERY_KDF_PROFILE);
  expect(recoverable.recoveryCode).toMatch(/^[A-HJ-NP-Z2-9-]+$/u);
  expect(JSON.stringify(recoverable.envelope)).not.toContain(recoverable.recoveryCode);
  await expect(crypto.subtle.exportKey("raw", recoverable.key)).rejects.toBeDefined();

  const plaintext = new TextEncoder().encode("SYNTHETIC TEST RECORD — NOT A REAL PATIENT");
  const encrypted = await encryptVaultBlob(recoverable.key, plaintext, scope);
  const restoredKey = await recoverVault(
    recoverable.recoveryCode,
    "synthetic-household",
    recoverable.envelope,
  );
  const decrypted = await decryptVaultBlob(restoredKey, encrypted, scope);
  expect([...decrypted]).toEqual([...plaintext]);
});

it("fails closed for a wrong recovery code, household, or modified envelope", async () => {
  const recoverable = await createRecoverableVault("synthetic-household");
  const another = await createRecoverableVault("synthetic-household");
  await expect(
    recoverVault(another.recoveryCode, "synthetic-household", recoverable.envelope),
  ).rejects.toBeInstanceOf(RecoveryError);

  await expect(
    recoverVault(recoverable.recoveryCode, "another-household", recoverable.envelope),
  ).rejects.toBeInstanceOf(RecoveryError);

  const tampered = {
    ...recoverable.envelope,
    ciphertext: recoverable.envelope.ciphertext.slice(0),
  };
  new Uint8Array(tampered.ciphertext)[0] ^= 1;
  await expect(
    recoverVault(recoverable.recoveryCode, "synthetic-household", tampered),
  ).rejects.toBeInstanceOf(RecoveryError);

  const replacement = recoverable.recoveryCode.endsWith("A") ? "B" : "A";
  const alteredCode = `${recoverable.recoveryCode.slice(0, -1)}${replacement}`;
  await expect(
    recoverVault(alteredCode, "synthetic-household", recoverable.envelope),
  ).rejects.toBeInstanceOf(RecoveryError);
});

it("rejects attacker-chosen KDF profiles before doing expensive work", async () => {
  const recoverable = await createRecoverableVault("synthetic-household");
  const untrusted = {
    ...recoverable.envelope,
    kdfProfile: "argon2id-attacker-memory" as never,
  };
  await expect(
    recoverVault(recoverable.recoveryCode, "synthetic-household", untrusted),
  ).rejects.toBeInstanceOf(RecoveryError);
});
