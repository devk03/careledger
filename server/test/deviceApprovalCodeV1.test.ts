import { createHash } from "node:crypto";

import { encodeDeviceApprovalCodeMaterialV1,
  formatDeviceApprovalCodeV1, isDeviceApprovalCodeV1,
  DeviceApprovalCodeV1Error } from "@adeno/contracts";
import { expect, it } from "vitest";

it("binds the human comparison code to household, account, device and both keys", () => {
  const input = { householdId: "01".repeat(16), accountId: "02".repeat(16),
    deviceId: "03".repeat(16),
    encryptionPublicKey: new Uint8Array(32).fill(4),
    signingPublicKey: new Uint8Array(32).fill(5) };
  const expectedBytes = Buffer.concat([
    Buffer.from("adeno:managed:device-approval:v1\0", "utf8"),
    Buffer.from(input.householdId, "hex"),
    Buffer.from(input.accountId, "hex"),
    Buffer.from(input.deviceId, "hex"),
    Buffer.alloc(32, 4), Buffer.alloc(32, 5),
  ]);
  const material = encodeDeviceApprovalCodeMaterialV1(input);
  expect(Buffer.from(material)).toEqual(expectedBytes);
  const code = formatDeviceApprovalCodeV1(
    createHash("sha256").update(material).digest());
  expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/u);
  expect(isDeviceApprovalCodeV1(code)).toBe(true);
  expect(isDeviceApprovalCodeV1(code.toUpperCase())).toBe(true);
  for (const change of [
    { householdId: "06".repeat(16) }, { accountId: "07".repeat(16) },
    { deviceId: "08".repeat(16) },
    { encryptionPublicKey: new Uint8Array(32).fill(9) },
    { signingPublicKey: new Uint8Array(32).fill(10) },
  ]) {
    const changed = encodeDeviceApprovalCodeMaterialV1({ ...input, ...change });
    expect(changed).not.toEqual(material);
    expect(formatDeviceApprovalCodeV1(createHash("sha256").update(changed)
      .digest())).not.toBe(code);
  }
  expect(() => encodeDeviceApprovalCodeMaterialV1({ ...input,
    deviceId: "bad" })).toThrow(DeviceApprovalCodeV1Error);
  expect(() => formatDeviceApprovalCodeV1(new Uint8Array(6)))
    .toThrow(DeviceApprovalCodeV1Error);
});
