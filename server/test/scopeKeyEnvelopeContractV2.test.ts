import { expect, it } from "vitest";

import { SCOPE_KEY_WIRE_BYTES_V2, ScopeKeyEnvelopeWireV2Error,
  decodeScopeKeyEnvelopeV2, encodeScopeKeyEnvelopeV2 } from "@adeno/contracts";

// Wholly fictional structural vector; not HPKE-valid or a real record.
const goldenHex = "41444b5902010000" + "aa".repeat(16) +
  "bb".repeat(16) + "cc".repeat(16) + "dd".repeat(16) + "ee".repeat(16) +
  "00000001" + "03000000" + "ff".repeat(32) + "99".repeat(32) +
  "11".repeat(32) + "22".repeat(48);

it("Node parses the canonical 240-byte scope-key v2 vector", () => {
  const wire = Buffer.from(goldenHex, "hex");
  expect(wire.byteLength).toBe(SCOPE_KEY_WIRE_BYTES_V2);
  const decoded = decodeScopeKeyEnvelopeV2(wire);
  expect(decoded.context).toEqual({ householdId: "aa".repeat(16),
    careProfileId: "bb".repeat(16), opaqueScopeId: "cc".repeat(16),
    keyId: "dd".repeat(16), recipientDeviceId: "ee".repeat(16),
    keyEpoch: 1, purpose: "draft" });
  expect(decoded.keyCommitmentSha256).toBe("ff".repeat(32));
  expect(Buffer.from(encodeScopeKeyEnvelopeV2(decoded)).toString("hex"))
    .toBe(goldenHex);
  wire.fill(0);
  expect(Buffer.from(encodeScopeKeyEnvelopeV2(decoded)).toString("hex"))
    .toBe(goldenHex);
});

it("Node rejects v1, truncated, extended and reserved-byte vectors", () => {
  const wire = Buffer.from(goldenHex, "hex");
  for (const bad of [wire.subarray(0, -1),
    Buffer.concat([wire, Buffer.from([0])]),
    Buffer.from(wire.map((byte, index) => index === 4 ? 1 : byte)),
    Buffer.from(wire.map((byte, index) => index === 93 ? 1 : byte))]) {
    expect(() => decodeScopeKeyEnvelopeV2(bad))
      .toThrow(ScopeKeyEnvelopeWireV2Error);
  }
});
