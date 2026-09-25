import { expect, it } from "vitest";

import { decryptVaultBlob, encryptVaultBlob } from "./vault";
import { createRecoverableVault, recoverVault } from "./recovery";
import { decodeRecoveryEnvelope, encodeRecoveryEnvelope,
  RecoveryEnvelopeWireError } from "./recoveryEnvelopeWire";

const householdId = "fictional-family-a";
const scope = { householdId, objectId: "opaque-fictional-item", revision: 1 };

it("round-trips a wrapped key without storing the caregiver recovery code", async () => {
  const created = await createRecoverableVault(householdId);
  const wire = encodeRecoveryEnvelope(created.envelope);
  expect(wire.byteLength).toBe(97);
  expect(new TextDecoder().decode(wire)).not.toContain(created.recoveryCode);
  const copy = wire.slice();
  const decoded = decodeRecoveryEnvelope(copy);
  copy.fill(0);
  const restored = await recoverVault(created.recoveryCode, householdId, decoded);
  const plaintext = new TextEncoder().encode("FICTIONAL_RECOVERY_MARKER_NOT_A_REAL_RECORD");
  const encrypted = await encryptVaultBlob(created.key, plaintext, scope);
  expect([...await decryptVaultBlob(restored, encrypted, scope)]).toEqual([...plaintext]);
});

it("rejects malformed framing and fails authentication for modified ciphertext", async () => {
  const created = await createRecoverableVault(householdId);
  const wire = encodeRecoveryEnvelope(created.envelope);
  for (const candidate of [
    wire.subarray(0, -1), new Uint8Array([...wire, 0]),
    Uint8Array.from(wire, (byte, index) => index === 0 ? byte ^ 1 : byte),
    Uint8Array.from(wire, (byte, index) => index === 4 ? 2 : byte),
  ]) expect(() => decodeRecoveryEnvelope(candidate)).toThrow(RecoveryEnvelopeWireError);
  const tampered = wire.slice();
  tampered[tampered.length - 1] ^= 1;
  const decoded = decodeRecoveryEnvelope(tampered);
  await expect(recoverVault(created.recoveryCode, householdId, decoded)).rejects.toThrow();
  expect(() => encodeRecoveryEnvelope({ ...created.envelope,
    ciphertext: new ArrayBuffer(47) })).toThrow(RecoveryEnvelopeWireError);
});
