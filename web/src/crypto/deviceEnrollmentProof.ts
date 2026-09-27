import { encodeDeviceEnrollmentNonceMaterialV1,
  encodeDeviceEnrollmentProofV1,
  encodeDeviceEnrollmentProofWireV1,
  encodeDeviceEnrollmentChallengeWireV1,
  encodeDeviceApprovalCodeMaterialV1, formatDeviceApprovalCodeV1,
  parseDeviceEnrollmentChallengeWireV1,
  type DeviceEnrollmentChallengeWireV1,
  type DeviceEnrollmentProofWireV1 } from "@adeno/contracts";

export type ExpectedManagedDeviceSession = {
  householdId: string; accountId: string; sessionId: string;
  origin: string;
};

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

/**
 * Validate the server challenge against the authenticated managed session,
 * this origin and both local keypairs before any future save-once operation.
 * The canonical wire includes the ephemeral public key needed after reload.
 * This is not proof of human approval or durable key storage.
 */
export async function validateProposedDeviceChallengeWire(
  wire: unknown, keys: { encryptionKeys: CryptoKeyPair;
    signingKeys: CryptoKeyPair }, expected: ExpectedManagedDeviceSession,
): Promise<{ deviceId: string; wire: DeviceEnrollmentChallengeWireV1 }> {
  try {
    const challenge = parseDeviceEnrollmentChallengeWireV1(wire);
    const stableKeys = snapshotKeys(keys);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const clockSkew = 60n;
    if (!expected || challenge.householdId !== expected.householdId ||
      challenge.accountId !== expected.accountId ||
      challenge.sessionId !== expected.sessionId ||
      !trustedOrigin(expected.origin) ||
      challenge.expiresAt <= now - clockSkew ||
      challenge.expiresAt > now + 600n + clockSkew)
      throw new BrowserDeviceEnrollmentProofError();
    const local = await proposedDevicePublicKeys(stableKeys);
    if (local.encryptionPublicKeyHex !== hex(challenge.encryptionPublicKey) ||
      local.signingPublicKeyHex !== hex(challenge.signingPublicKey))
      throw new BrowserDeviceEnrollmentProofError();
    await assertKeyPairCoherence(stableKeys);
    const ephemeral = await crypto.subtle.importKey("raw",
      buffer(challenge.ephemeralPublicKey), "X25519", false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({
      name: "X25519", public: ephemeral,
    }, stableKeys.encryptionKeys.privateKey, 256));
    shared.fill(0);
    return { deviceId: challenge.challengeId,
      wire: encodeDeviceEnrollmentChallengeWireV1({
        householdId: challenge.householdId,
        accountId: challenge.accountId, sessionId: challenge.sessionId,
        challengeId: challenge.challengeId,
        ephemeralPublicKey: challenge.ephemeralPublicKey,
        expiresAt: challenge.expiresAt,
        encryptionPublicKey: challenge.encryptionPublicKey,
        signingPublicKey: challenge.signingPublicKey,
      }) };
  } catch { throw new BrowserDeviceEnrollmentProofError(); }
}

/**
 * Show this on the candidate device for a human to compare and type on the
 * owner's device. Never accept a code fetched from the server as confirmation.
 */
export async function candidateDeviceApprovalCode(wire: unknown, keys: {
  encryptionKeys: CryptoKeyPair; signingKeys: CryptoKeyPair,
}, expected: ExpectedManagedDeviceSession): Promise<string> {
  try {
    const stableKeys = snapshotKeys(keys);
    const validated = await validateProposedDeviceChallengeWire(
      wire, stableKeys, expected);
    const challenge = parseDeviceEnrollmentChallengeWireV1(validated.wire);
    const material = encodeDeviceApprovalCodeMaterialV1({
      householdId: challenge.householdId, accountId: challenge.accountId,
      deviceId: challenge.challengeId,
      encryptionPublicKey: challenge.encryptionPublicKey,
      signingPublicKey: challenge.signingPublicKey,
    });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
      buffer(material)));
    return formatDeviceApprovalCodeV1(digest);
  } catch { throw new BrowserDeviceEnrollmentProofError(); }
}

/** Signs only exact server challenge fields matching both locally held keys.
 * This proves key possession, not human approval or durable key storage. */
export async function signDeviceEnrollmentChallengeWire(
  wire: unknown, keys: { encryptionKeys: CryptoKeyPair;
    signingKeys: CryptoKeyPair },
  expected: ExpectedManagedDeviceSession,
): Promise<DeviceEnrollmentProofWireV1> {
  try {
    const stableKeys = snapshotKeys(keys);
    const validated = await validateProposedDeviceChallengeWire(
      wire, stableKeys, expected);
    const challenge = parseDeviceEnrollmentChallengeWireV1(validated.wire);
    const origin = expected.origin;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const clockSkew = 60n;
    if (challenge.expiresAt <= now - clockSkew ||
      challenge.expiresAt > now + 600n + clockSkew)
      throw new BrowserDeviceEnrollmentProofError();
    const localKeys = await proposedDevicePublicKeys(stableKeys);
    if (localKeys.encryptionPublicKeyHex !== hex(challenge.encryptionPublicKey) ||
      localKeys.signingPublicKeyHex !== hex(challenge.signingPublicKey))
      throw new BrowserDeviceEnrollmentProofError();
    const audienceSha256 = await sha256Hex(new TextEncoder().encode(origin));
    const ephemeral = await crypto.subtle.importKey("raw",
      buffer(challenge.ephemeralPublicKey), "X25519", false, []);
    const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({
      name: "X25519", public: ephemeral,
    }, stableKeys.encryptionKeys.privateKey, 256));
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
      stableKeys.signingKeys.privateKey, buffer(payload)));
    if (signature.byteLength !== 64 ||
      !await crypto.subtle.verify("Ed25519", stableKeys.signingKeys.publicKey,
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

function snapshotKeys(keys: { encryptionKeys: CryptoKeyPair;
  signingKeys: CryptoKeyPair }): { encryptionKeys: CryptoKeyPair;
    signingKeys: CryptoKeyPair } {
  assertKeys(keys);
  return { encryptionKeys: { privateKey: keys.encryptionKeys.privateKey,
    publicKey: keys.encryptionKeys.publicKey },
  signingKeys: { privateKey: keys.signingKeys.privateKey,
    publicKey: keys.signingKeys.publicKey } };
}

async function assertKeyPairCoherence(keys: { encryptionKeys: CryptoKeyPair;
  signingKeys: CryptoKeyPair }): Promise<void> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
    keys.signingKeys.privateKey, buffer(challenge)));
  const signed = await crypto.subtle.verify("Ed25519",
    keys.signingKeys.publicKey, buffer(signature), buffer(challenge));
  challenge.fill(0);
  signature.fill(0);
  if (!signed) throw new BrowserDeviceEnrollmentProofError();
  const ephemeral = await crypto.subtle.generateKey("X25519", false,
    ["deriveBits"]);
  if (!("privateKey" in ephemeral))
    throw new BrowserDeviceEnrollmentProofError();
  const left = new Uint8Array(await crypto.subtle.deriveBits({
    name: "X25519", public: ephemeral.publicKey,
  }, keys.encryptionKeys.privateKey, 256));
  const right = new Uint8Array(await crypto.subtle.deriveBits({
    name: "X25519", public: keys.encryptionKeys.publicKey,
  }, ephemeral.privateKey, 256));
  let different = 0;
  for (let index = 0; index < 32; index += 1)
    different |= left[index]! ^ right[index]!;
  left.fill(0);
  right.fill(0);
  if (different !== 0) throw new BrowserDeviceEnrollmentProofError();
}

function trustedOrigin(expectedOrigin: string): boolean {
  try {
    if (typeof expectedOrigin !== "string" ||
      globalThis.location?.origin !== expectedOrigin) return false;
    const parsed = new URL(expectedOrigin);
    return parsed.origin === expectedOrigin &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)));
  } catch { return false; }
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
