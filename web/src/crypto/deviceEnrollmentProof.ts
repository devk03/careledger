import { encodeDeviceEnrollmentNonceMaterialV1,
  encodeDeviceEnrollmentProofV1,
  encodeDeviceEnrollmentProofWireV1,
  parseDeviceEnrollmentChallengeWireV1,
  type DeviceEnrollmentProofWireV1 } from "@adeno/contracts";

export class BrowserDeviceEnrollmentProofError extends Error {
  constructor() {
    super("This device could not confirm its proposed keys.");
    this.name = "BrowserDeviceEnrollmentProofError";
  }
}

/** Browser-generated non-extractable private keys; persistence is a separate gate. */
export async function generateProposedDeviceKeys(): Promise<{
  encryptionKeys: CryptoKeyPair; signingKeys: CryptoKeyPair;
}> {
  try {
    const encryptionKeys = await crypto.subtle.generateKey("X25519", false,
      ["deriveBits"]);
    const signingKeys = await crypto.subtle.generateKey("Ed25519", false,
      ["sign", "verify"]);
    if (!("privateKey" in encryptionKeys) ||
      !("privateKey" in signingKeys) ||
      encryptionKeys.privateKey.extractable || signingKeys.privateKey.extractable)
      throw new BrowserDeviceEnrollmentProofError();
    return { encryptionKeys, signingKeys };
  } catch { throw new BrowserDeviceEnrollmentProofError(); }
}

export async function proposedDevicePublicKeys(input: {
  encryptionKeys: CryptoKeyPair; signingKeys: CryptoKeyPair;
}): Promise<{ encryptionPublicKeyHex: string; signingPublicKeyHex: string }> {
  try {
    assertKeys(input);
    const encryption = new Uint8Array(await crypto.subtle.exportKey("raw",
      input.encryptionKeys.publicKey));
    const signing = new Uint8Array(await crypto.subtle.exportKey("raw",
      input.signingKeys.publicKey));
    if (encryption.byteLength !== 32 || signing.byteLength !== 32)
      throw new BrowserDeviceEnrollmentProofError();
    return { encryptionPublicKeyHex: hex(encryption),
      signingPublicKeyHex: hex(signing) };
  } catch { throw new BrowserDeviceEnrollmentProofError(); }
}

/** Signs only exact server challenge fields matching both locally held keys.
 * This proves key possession, not human approval or durable key storage. */
export async function signDeviceEnrollmentChallengeWire(
  wire: unknown, keys: { encryptionKeys: CryptoKeyPair;
    signingKeys: CryptoKeyPair },
): Promise<DeviceEnrollmentProofWireV1> {
  try {
    const challenge = parseDeviceEnrollmentChallengeWireV1(wire);
    assertKeys(keys);
    const origin = globalThis.location?.origin;
    if (typeof origin !== "string" || origin === "null")
      throw new BrowserDeviceEnrollmentProofError();
    const parsedOrigin = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"]
      .includes(parsedOrigin.hostname);
    if ((parsedOrigin.protocol !== "https:" &&
      !(parsedOrigin.protocol === "http:" && local)) ||
      parsedOrigin.origin !== origin)
      throw new BrowserDeviceEnrollmentProofError();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const skew = 60n;
    if (challenge.expiresAt <= now - skew ||
      challenge.expiresAt > now + 600n + skew)
      throw new BrowserDeviceEnrollmentProofError();
    const localKeys = await proposedDevicePublicKeys(keys);
    if (localKeys.encryptionPublicKeyHex !== hex(challenge.encryptionPublicKey) ||
      localKeys.signingPublicKeyHex !== hex(challenge.signingPublicKey))
      throw new BrowserDeviceEnrollmentProofError();
    const audienceSha256 = await sha256Hex(new TextEncoder().encode(origin));
    const ephemeral = await crypto.subtle.importKey("raw",
      buffer(challenge.ephemeralPublicKey), "X25519", false, []);
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({
      name: "X25519", public: ephemeral,
    }, keys.encryptionKeys.privateKey, 256));
    const material = encodeDeviceEnrollmentNonceMaterialV1({ sharedSecret,
      challengeId: challenge.challengeId, audienceSha256 });
    const nonce = new Uint8Array(await crypto.subtle.digest("SHA-256",
      buffer(material)));
    sharedSecret.fill(0);
    material.fill(0);
    const payload = encodeDeviceEnrollmentProofV1({
      householdId: challenge.householdId, accountId: challenge.accountId,
      sessionId: challenge.sessionId, challengeId: challenge.challengeId,
      nonceSha256: await sha256Hex(nonce),
      audienceSha256,
      encryptionPublicKeyHex: localKeys.encryptionPublicKeyHex,
      signingPublicKeyHex: localKeys.signingPublicKeyHex,
      expiresAt: challenge.expiresAt,
    });
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
      keys.signingKeys.privateKey, buffer(payload)));
    if (signature.byteLength !== 64 ||
      !await crypto.subtle.verify("Ed25519", keys.signingKeys.publicKey,
        buffer(signature), buffer(payload)))
      throw new BrowserDeviceEnrollmentProofError();
    return encodeDeviceEnrollmentProofWireV1({
      challengeId: challenge.challengeId, nonce, signature,
    });
  } catch { throw new BrowserDeviceEnrollmentProofError(); }
}

function assertKeys(keys: { encryptionKeys: CryptoKeyPair;
  signingKeys: CryptoKeyPair }): void {
  const enc = keys?.encryptionKeys;
  const sign = keys?.signingKeys;
  if (!enc?.privateKey || enc.privateKey.type !== "private" ||
    enc.privateKey.algorithm.name !== "X25519" || enc.privateKey.extractable ||
    !enc.privateKey.usages.includes("deriveBits") ||
    !enc.publicKey || enc.publicKey.type !== "public" ||
    enc.publicKey.algorithm.name !== "X25519" ||
    !sign?.privateKey || sign.privateKey.type !== "private" ||
    sign.privateKey.algorithm.name !== "Ed25519" || sign.privateKey.extractable ||
    !sign.privateKey.usages.includes("sign") ||
    !sign.publicKey || sign.publicKey.type !== "public" ||
    sign.publicKey.algorithm.name !== "Ed25519" ||
    !sign.publicKey.usages.includes("verify"))
    throw new BrowserDeviceEnrollmentProofError();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes))));
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
