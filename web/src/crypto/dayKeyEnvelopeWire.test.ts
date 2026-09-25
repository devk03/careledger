import { expect, it } from "vitest";

import { DayKeyEnvelopeError, createDayKeyEnvelopes,
  generateDeviceEncryptionKeys, openDayKeyEnvelope } from "./dayKeyEnvelope";
import { DayKeyEnvelopeWireError, decodeDayKeyEnvelope,
  encodeDayKeyEnvelope } from "./dayKeyEnvelopeWire";
import { decodeRecoveryEnvelope, RecoveryEnvelopeWireError } from "./recoveryEnvelopeWire";
import { VaultWireError, decodeVaultBlob, encodeVaultBlob } from "./vaultWire";
import { encryptVaultBlob, decryptVaultBlob } from "./vault";

const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
  opaqueDayId: "c".repeat(32), keyEpoch: 1 };
const recipientDeviceId = "d".repeat(32);
const expected = { ...identity, recipientDeviceId };
const recordScope = { householdId: identity.householdId,
  objectId: identity.opaqueDayId, revision: 1 };
const fictional = new TextEncoder().encode("FICTIONAL WIRE MARKER — NO REAL RECORD");

async function fixture() {
  const recipient = await generateDeviceEncryptionKeys();
  const { key, envelopes } = await createDayKeyEnvelopes(identity,
    [{ deviceId: recipientDeviceId, publicKey: recipient.publicKey }]);
  return { recipient, key, envelope: envelopes[0]! };
}

it("round-trips exactly 188 opaque bytes and opens only after HPKE authentication", async () => {
  const { recipient, key, envelope } = await fixture();
  const wire = encodeDayKeyEnvelope(envelope);
  expect(wire.byteLength).toBe(188);
  expect([...wire.subarray(0, 8)]).toEqual([65, 68, 75, 89, 1, 1, 0, 0]);
  expect(new TextDecoder().decode(wire)).not.toContain("FICTIONAL WIRE MARKER");
  const offsetBuffer = new Uint8Array(wire.byteLength + 13);
  offsetBuffer.set(wire, 7);
  const decoded = decodeDayKeyEnvelope(offsetBuffer.subarray(7, 7 + wire.byteLength));
  expect(encodeDayKeyEnvelope(decoded)).toEqual(wire);
  offsetBuffer.fill(0);
  expect(encodeDayKeyEnvelope(decoded)).toEqual(wire);
  const opened = await openDayKeyEnvelope(expected, decoded, recipient);
  const blob = await encryptVaultBlob(key, fictional, recordScope);
  expect([...(await decryptVaultBlob(opened, blob, recordScope))]).toEqual([...fictional]);
});

it("rejects every truncated length, trailing byte, wrong magic/version, and zero epoch", async () => {
  const { envelope } = await fixture();
  const wire = encodeDayKeyEnvelope(envelope);
  for (let length = 0; length < wire.byteLength; length += 1) {
    expect(() => decodeDayKeyEnvelope(wire.subarray(0, length)))
      .toThrow(DayKeyEnvelopeWireError);
  }
  for (const changed of [
    new Uint8Array([...wire, 0]),
    Uint8Array.from(wire, (byte, index) => index === 0 ? byte ^ 1 : byte),
    Uint8Array.from(wire, (byte, index) => index === 4 ? 2 : byte),
    Uint8Array.from(wire, (byte, index) => index === 5 ? 2 : byte),
    Uint8Array.from(wire, (byte, index) => index === 6 ? 1 : byte),
    Uint8Array.from(wire, (byte, index) => index === 7 ? 1 : byte),
    Uint8Array.from(wire, (byte, index) => index === 75 ? 0 : byte),
  ]) expect(() => decodeDayKeyEnvelope(changed)).toThrow(DayKeyEnvelopeWireError);
});

it("rejects extra or non-opaque fields before encoding", async () => {
  const { envelope } = await fixture();
  for (const changed of [
    { ...envelope, patientName: "Synthetic name" },
    { ...envelope, context: { ...envelope.context, careDate: "2030-04-12" } },
    { ...envelope, context: { ...envelope.context, opaqueDayId: "2030-04-12" } },
    { ...envelope, context: { ...envelope.context, keyEpoch: 0 } },
    { ...envelope, encapsulatedKey: new Uint8Array(31) },
    { ...envelope, ciphertext: new ArrayBuffer(47) },
  ]) expect(() => encodeDayKeyEnvelope(changed as never)).toThrow(DayKeyEnvelopeWireError);
});

it("keeps the ADKY envelope separate from blob and recovery wire formats", async () => {
  const { key, envelope } = await fixture();
  const dayWire = encodeDayKeyEnvelope(envelope);
  expect(() => decodeVaultBlob(dayWire)).toThrow(VaultWireError);
  expect(() => decodeRecoveryEnvelope(dayWire)).toThrow(RecoveryEnvelopeWireError);
  const blobWire = encodeVaultBlob(await encryptVaultBlob(key, fictional, recordScope));
  expect(() => decodeDayKeyEnvelope(blobWire)).toThrow(DayKeyEnvelopeWireError);
});

it("rejects every single-byte mutation by framing or HPKE authentication", async () => {
  const { recipient, envelope } = await fixture();
  const wire = encodeDayKeyEnvelope(envelope);
  for (let offset = 0; offset < wire.byteLength; offset += 1) {
    const tampered = wire.slice();
    tampered[offset] ^= 1;
    let decoded;
    try { decoded = decodeDayKeyEnvelope(tampered); }
    catch (error) {
      expect(error).toBeInstanceOf(DayKeyEnvelopeWireError);
      continue;
    }
    await expect(openDayKeyEnvelope(expected, decoded, recipient))
      .rejects.toBeInstanceOf(DayKeyEnvelopeError);
  }
});

it("shows why an unsigned HPKE envelope must not be mistaken for an approved grant", async () => {
  const { recipient } = await fixture();
  // Anyone with the public key can create another valid, same-scope envelope.
  const forged = await createDayKeyEnvelopes(identity,
    [{ deviceId: recipientDeviceId, publicKey: recipient.publicKey }]);
  const decoded = decodeDayKeyEnvelope(encodeDayKeyEnvelope(forged.envelopes[0]!));
  await expect(openDayKeyEnvelope(expected, decoded, recipient)).resolves.toBeDefined();
});
