import { expect, it } from "vitest";

import { VaultIntegrityError, decryptVaultBlob, encryptVaultBlob } from "./vault";
import {
  DAY_KEY_ENVELOPE_FORMAT,
  DayKeyEnvelopeError,
  createDayKeyEnvelopes,
  generateDeviceEncryptionKeys,
  openDayKeyEnvelope,
  type DayKeyContext,
  type DayKeyEnvelope,
} from "./dayKeyEnvelope";

const identity = {
  householdId: "a".repeat(32),
  careProfileId: "b".repeat(32),
  opaqueDayId: "c".repeat(32),
  keyEpoch: 1,
};
const ownerId = "d".repeat(32);
const memberId = "e".repeat(32);
const context = (deviceId = ownerId): DayKeyContext => ({
  ...identity, recipientDeviceId: deviceId,
});
const recordScope = { householdId: identity.householdId,
  objectId: identity.opaqueDayId, revision: 1 };
const fictional = new TextEncoder().encode("FICTIONAL RECORD ALPHA — NO REAL PATIENT");

it("wraps a random day key separately for two devices, without exporting the content key", async () => {
  const owner = await generateDeviceEncryptionKeys();
  const member = await generateDeviceEncryptionKeys();
  const outsider = await generateDeviceEncryptionKeys();
  const { key, envelopes } = await createDayKeyEnvelopes(identity, [
    { deviceId: ownerId, publicKey: owner.publicKey },
    { deviceId: memberId, publicKey: member.publicKey },
  ]);
  expect(envelopes).toHaveLength(2);
  expect(envelopes[0]?.format).toBe(DAY_KEY_ENVELOPE_FORMAT);
  expect(JSON.stringify(envelopes)).not.toContain("FICTIONAL RECORD ALPHA");
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  await expect(crypto.subtle.exportKey("pkcs8", owner.privateKey)).rejects.toBeDefined();

  const encrypted = await encryptVaultBlob(key, fictional, recordScope);
  for (const [index, pair, deviceId] of [
    [0, owner, ownerId], [1, member, memberId],
  ] as const) {
    const opened = await openDayKeyEnvelope(context(deviceId), envelopes[index]!, pair);
    expect([...(await decryptVaultBlob(opened, encrypted, recordScope))]).toEqual([...fictional]);
  }
  await expect(openDayKeyEnvelope(context(ownerId), envelopes[0]!, outsider))
    .rejects.toBeInstanceOf(DayKeyEnvelopeError);
});

it("fails for a different day, household, profile, epoch, or recipient", async () => {
  const owner = await generateDeviceEncryptionKeys();
  const { envelopes } = await createDayKeyEnvelopes(identity,
    [{ deviceId: ownerId, publicKey: owner.publicKey }]);
  const envelope = envelopes[0]!;
  for (const changed of [
    { householdId: "f".repeat(32) },
    { careProfileId: "f".repeat(32) },
    { opaqueDayId: "f".repeat(32) },
    { keyEpoch: 2 },
    { recipientDeviceId: memberId },
  ]) {
    await expect(openDayKeyEnvelope({ ...context(), ...changed }, envelope, owner))
      .rejects.toBeInstanceOf(DayKeyEnvelopeError);
  }
});

it("one granted day key cannot decrypt another care day's record", async () => {
  const member = await generateDeviceEncryptionKeys();
  const owner = await generateDeviceEncryptionKeys();
  const first = await createDayKeyEnvelopes(identity,
    [{ deviceId: memberId, publicKey: member.publicKey }]);
  const otherDayId = "f".repeat(32);
  const second = await createDayKeyEnvelopes({ ...identity, opaqueDayId: otherDayId },
    [{ deviceId: ownerId, publicKey: owner.publicKey }]);
  const firstKey = await openDayKeyEnvelope(context(memberId), first.envelopes[0]!, member);
  const otherRecord = await encryptVaultBlob(second.key, fictional,
    { ...recordScope, objectId: otherDayId });
  await expect(decryptVaultBlob(firstKey, otherRecord,
    { ...recordScope, objectId: otherDayId })).rejects.toBeInstanceOf(VaultIntegrityError);
});

it("rejects changed suite, context, encapsulated key, and authentication tag", async () => {
  const owner = await generateDeviceEncryptionKeys();
  const { envelopes } = await createDayKeyEnvelopes(identity,
    [{ deviceId: ownerId, publicKey: owner.publicKey }]);
  const envelope = envelopes[0]!;
  const changed = (edit: (value: DayKeyEnvelope) => void): DayKeyEnvelope => {
    const copy = structuredClone(envelope);
    edit(copy);
    return copy;
  };
  const cases = [
    changed((value) => { value.format = "other-suite" as never; }),
    changed((value) => { value.recipientKeySha256 = "0".repeat(64); }),
    changed((value) => { value.context.opaqueDayId = "f".repeat(32); }),
    changed((value) => { value.encapsulatedKey[0] ^= 1; }),
    changed((value) => { new Uint8Array(value.ciphertext)[47] ^= 1; }),
  ];
  for (const tampered of cases) {
    await expect(openDayKeyEnvelope(context(), tampered, owner))
      .rejects.toBeInstanceOf(DayKeyEnvelopeError);
  }
});

it("makes independent HPKE encapsulations for repeated envelopes", async () => {
  const owner = await generateDeviceEncryptionKeys();
  const first = (await createDayKeyEnvelopes(identity,
    [{ deviceId: ownerId, publicKey: owner.publicKey }])).envelopes[0]!;
  const second = (await createDayKeyEnvelopes(identity,
    [{ deviceId: ownerId, publicKey: owner.publicKey }])).envelopes[0]!;
  expect(first.encapsulatedKey).not.toEqual(second.encapsulatedKey);
  expect(new Uint8Array(first.ciphertext)).not.toEqual(new Uint8Array(second.ciphertext));
});

it("uses one copied scope and envelope even if caller objects change during awaits", async () => {
  const owner = await generateDeviceEncryptionKeys();
  const mutableIdentity = { ...identity };
  const mutableRecipient = { deviceId: ownerId, publicKey: owner.publicKey };
  const creating = createDayKeyEnvelopes(mutableIdentity, [mutableRecipient]);
  mutableIdentity.opaqueDayId = "f".repeat(32);
  mutableRecipient.deviceId = memberId;
  const { envelopes } = await creating;
  expect(envelopes[0]?.context).toEqual(context());
  await expect(openDayKeyEnvelope(context(), envelopes[0]!, owner)).resolves.toBeDefined();

  const originalEnvelope = envelopes[0]!;
  const mutableEnvelope = { ...originalEnvelope,
    context: { ...originalEnvelope.context },
    encapsulatedKey: new Uint8Array(originalEnvelope.encapsulatedKey),
    ciphertext: originalEnvelope.ciphertext.slice(0) };
  await expect(openDayKeyEnvelope(context(), mutableEnvelope, owner)).resolves.toBeDefined();
  const opening = openDayKeyEnvelope(context(), mutableEnvelope, owner);
  mutableEnvelope.context.opaqueDayId = "f".repeat(32);
  mutableEnvelope.ciphertext = new ArrayBuffer(48);
  const opened = await opening;
  await expect(crypto.subtle.exportKey("raw", opened)).rejects.toBeDefined();
});

it("rejects non-opaque IDs, duplicate recipients, and malformed envelopes", async () => {
  const owner = await generateDeviceEncryptionKeys();
  await expect(createDayKeyEnvelopes({ ...identity, opaqueDayId: "2030-04-12" },
    [{ deviceId: ownerId, publicKey: owner.publicKey }]))
    .rejects.toBeInstanceOf(DayKeyEnvelopeError);
  await expect(createDayKeyEnvelopes({ ...identity, careDate: "2030-04-12" } as never,
    [{ deviceId: ownerId, publicKey: owner.publicKey }]))
    .rejects.toBeInstanceOf(DayKeyEnvelopeError);
  await expect(createDayKeyEnvelopes(identity, [
    { deviceId: ownerId, publicKey: owner.publicKey },
    { deviceId: ownerId, publicKey: owner.publicKey },
  ])).rejects.toBeInstanceOf(DayKeyEnvelopeError);
  const { envelopes } = await createDayKeyEnvelopes(identity,
    [{ deviceId: ownerId, publicKey: owner.publicKey }]);
  const truncated = { ...envelopes[0]!, ciphertext: new ArrayBuffer(47) };
  await expect(openDayKeyEnvelope(context(), truncated, owner))
    .rejects.toBeInstanceOf(DayKeyEnvelopeError);
  await expect(openDayKeyEnvelope(context(),
    { ...envelopes[0]!, patientName: "Synthetic name" } as never, owner))
    .rejects.toBeInstanceOf(DayKeyEnvelopeError);
});
