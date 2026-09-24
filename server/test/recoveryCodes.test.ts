import { describe, expect, it } from "vitest";

import { generateRecoveryCodes, recoveryCodeHash, verifyRecoveryCode } from "../src/auth/recoveryCodes.js";

describe("Python-compatible owner recovery codes", () => {
  it("matches the released HMAC normalization and produces one-use-shaped codes", () => {
    const pepper = Buffer.alloc(32, 7);
    expect(recoveryCodeHash("ABCD-EFGH-IJKL-MNOP", pepper))
      .toBe("33723849b0085988699b599ac83feba8e8b09bfecc885d5a60087b062c4ede48");
    const generated = generateRecoveryCodes(pepper);
    expect(generated.plaintext).toHaveLength(10);
    expect(new Set(generated.plaintext).size).toBe(10);
    for (const [index, code] of generated.plaintext.entries()) {
      expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
      expect(verifyRecoveryCode(code, generated.hashes[index]!, pepper)).toBe(true);
    }
    expect(verifyRecoveryCode("wrong", generated.hashes[0]!, pepper)).toBe(false);
  });
});
