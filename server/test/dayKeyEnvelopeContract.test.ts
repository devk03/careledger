import { expect, it } from "vitest";

import { DAY_KEY_WIRE_BYTES, DayKeyEnvelopeWireError,
  decodeDayKeyEnvelope, encodeDayKeyEnvelope } from "@adeno/contracts";

// Wholly fictional structural vector, not an HPKE-valid envelope or a real record.
const goldenHex = "41444b5901010000" +
  "aa".repeat(16) + "bb".repeat(16) + "cc".repeat(16) + "dd".repeat(16) +
  "00000001" + "ee".repeat(32) + "11".repeat(32) + "22".repeat(48);

it("Node parses the canonical 188-byte ADKY vector without importing browser crypto", () => {
  const wire = Buffer.from(goldenHex, "hex");
  expect(wire.byteLength).toBe(DAY_KEY_WIRE_BYTES);
  const decoded = decodeDayKeyEnvelope(wire);
  expect(decoded.context).toEqual({ householdId: "aa".repeat(16),
    careProfileId: "bb".repeat(16), opaqueDayId: "cc".repeat(16),
    recipientDeviceId: "dd".repeat(16), keyEpoch: 1 });
  expect(decoded.recipientKeySha256).toBe("ee".repeat(32));
  expect(Buffer.from(encodeDayKeyEnvelope(decoded)).toString("hex")).toBe(goldenHex);
  wire.fill(0);
  expect(Buffer.from(encodeDayKeyEnvelope(decoded)).toString("hex")).toBe(goldenHex);
});

it("Node rejects truncated, extended, and unknown-suite vectors", () => {
  const wire = Buffer.from(goldenHex, "hex");
  for (const bad of [wire.subarray(0, -1), Buffer.concat([wire, Buffer.from([0])]),
    Buffer.from(wire.map((byte, index) => index === 5 ? 2 : byte))]) {
    expect(() => decodeDayKeyEnvelope(bad)).toThrow(DayKeyEnvelopeWireError);
  }
});
