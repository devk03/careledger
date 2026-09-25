import { expect, it } from "vitest";

import { DAY_KEY_WIRE_BYTES, DayKeyEnvelopeWireError,
  decodeDayKeyEnvelope, encodeDayKeyEnvelope } from "@adeno/contracts";
import { createDayKeyEnvelopes, DayKeyEnvelopeError,
  generateDeviceEncryptionKeys, openDayKeyEnvelope } from "../../web/src/crypto/dayKeyEnvelope.js";
import { encodeDayKeyEnvelope as browserEncode } from
  "../../web/src/crypto/dayKeyEnvelopeWire.js";

const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
  opaqueDayId: "c".repeat(32), keyEpoch: 1 };
const recipientDeviceId = "d".repeat(32);

it("Node reads exact browser envelope bytes without receiving a day key", async () => {
  const device = await generateDeviceEncryptionKeys();
  const { envelopes } = await createDayKeyEnvelopes(identity,
    [{ deviceId: recipientDeviceId, publicKey: device.publicKey }]);
  const browserWire = browserEncode(envelopes[0]!);
  expect(browserWire.byteLength).toBe(DAY_KEY_WIRE_BYTES);
  const nodeWire = Buffer.from(browserWire);
  const decoded = decodeDayKeyEnvelope(nodeWire);
  expect(encodeDayKeyEnvelope(decoded)).toEqual(browserWire);
  nodeWire.fill(0);
  expect(encodeDayKeyEnvelope(decoded)).toEqual(browserWire);
  expect(JSON.stringify(decoded)).not.toContain("FICTIONAL CLINICAL TEXT");
  await expect(openDayKeyEnvelope({ ...identity, recipientDeviceId }, decoded, device))
    .resolves.toBeDefined();
  await expect(openDayKeyEnvelope({ ...identity, householdId: "e".repeat(32),
    recipientDeviceId }, decoded, device)).rejects.toBeInstanceOf(DayKeyEnvelopeError);
});

it("Node rejects a malformed browser envelope before any key operation", async () => {
  const device = await generateDeviceEncryptionKeys();
  const { envelopes } = await createDayKeyEnvelopes(identity,
    [{ deviceId: recipientDeviceId, publicKey: device.publicKey }]);
  const wire = Buffer.from(browserEncode(envelopes[0]!));
  for (const bad of [wire.subarray(0, -1), Buffer.concat([wire, Buffer.from([0])]),
    Buffer.from(wire.map((byte, index) => index === 5 ? 2 : byte))]) {
    expect(() => decodeDayKeyEnvelope(bad)).toThrow(DayKeyEnvelopeWireError);
  }
});
