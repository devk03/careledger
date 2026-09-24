import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, matching Python's base64.b32encode for ten random bytes. */
function base32(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

export function recoveryCodeHash(code: string, pepper: Uint8Array): string {
  if (pepper.byteLength < 32) throw new Error("Recovery pepper must be at least 32 bytes");
  const normalized = code.replaceAll("-", "").trim().toUpperCase();
  return createHmac("sha256", pepper).update(normalized, "ascii").digest("hex");
}

export function verifyRecoveryCode(code: string, expectedHex: string, pepper: Uint8Array): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHex) || pepper.byteLength < 32) return false;
  const actual = Buffer.from(recoveryCodeHash(code, pepper), "hex");
  return timingSafeEqual(actual, Buffer.from(expectedHex, "hex"));
}

export function generateRecoveryCodes(pepper: Uint8Array, count = 10):
  { plaintext: string[]; hashes: string[] } {
  if (pepper.byteLength < 32 || !Number.isInteger(count) || count < 1 || count > 20)
    throw new Error("Invalid recovery-code settings");
  const plaintext: string[] = [];
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const compact = base32(randomBytes(10));
    const code = compact.match(/.{4}/g)!.join("-");
    plaintext.push(code);
    hashes.push(recoveryCodeHash(code, pepper));
  }
  return { plaintext, hashes };
}
