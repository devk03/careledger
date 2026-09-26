import { encodeSessionDeviceBindingProofV1,
  encodeSessionDeviceProofWireV1,
  parseSessionDeviceChallengeWireV1,
  type SessionDeviceBindingProofContextV1,
  type SessionDeviceProofWireV1 } from "@adeno/contracts";

export class BrowserDeviceBindingProofError extends Error {
  constructor() {
    super("This device could not confirm its session.");
    this.name = "BrowserDeviceBindingProofError";
  }
}

/** Browser transport boundary: parse exact JSON before signing and return
 * ordinary JSON rather than a BigInt or typed-array object. */
export async function signSessionDeviceBindingChallengeWire(
  wire: unknown, signingKeys: CryptoKeyPair,
): Promise<SessionDeviceProofWireV1> {
  try {
    const challenge = parseSessionDeviceChallengeWireV1(wire);
    const signed = await signSessionDeviceBindingProof({ ...challenge,
      signingKeys });
    return encodeSessionDeviceProofWireV1({
      challengeId: signed.context.challengeId, nonce: signed.nonce,
      signature: signed.signature,
    });
  } catch { throw new BrowserDeviceBindingProofError(); }
}

/** Signs one server-issued challenge on this device. Enrollment, human
 * approval and server-side one-use consumption are separate requirements. */
export async function signSessionDeviceBindingProof(input: {
  householdId: string;
  accountId: string;
  sessionId: string;
  deviceId: string;
  challengeId: string;
  nonce: Uint8Array;
  expiresAt: bigint;
  signingKeys: CryptoKeyPair;
}): Promise<{ context: SessionDeviceBindingProofContextV1;
  nonce: Uint8Array; signature: Uint8Array }> {
  try {
    // Freeze caller-controlled fields before the first asynchronous operation.
    const fields = { householdId: input.householdId, accountId: input.accountId,
      sessionId: input.sessionId, deviceId: input.deviceId,
      challengeId: input.challengeId, expiresAt: input.expiresAt };
    const nonce = copyBytes(input.nonce, 32);
    const privateKey = input.signingKeys.privateKey;
    const publicKey = input.signingKeys.publicKey;
    const origin = globalThis.location?.origin;
    const now = BigInt(Math.floor(Date.now() / 1000));
    // A device clock may differ slightly from the server clock. The server
    // still enforces the actual one-use challenge expiry when binding.
    const clockSkew = 60n;
    if (typeof origin !== "string" || origin === "null")
      throw new BrowserDeviceBindingProofError();
    const parsedOrigin = new URL(origin);
    const local = ["localhost", "127.0.0.1", "[::1]"]
      .includes(parsedOrigin.hostname);
    if ((parsedOrigin.protocol !== "https:" &&
      !(parsedOrigin.protocol === "http:" && local)) ||
      typeof fields.expiresAt !== "bigint" ||
      fields.expiresAt <= now - clockSkew ||
      fields.expiresAt > now + 300n + clockSkew ||
      !privateKey || privateKey.type !== "private" ||
      privateKey.algorithm.name !== "Ed25519" || privateKey.extractable ||
      !privateKey.usages.includes("sign") ||
      !publicKey || publicKey.type !== "public" ||
      publicKey.algorithm.name !== "Ed25519" ||
      !publicKey.usages.includes("verify"))
      throw new BrowserDeviceBindingProofError();
    const context: SessionDeviceBindingProofContextV1 = {
      ...fields,
      nonceSha256: await sha256Hex(nonce),
      audienceSha256: await sha256Hex(new TextEncoder().encode(origin)),
    };
    const payload = encodeSessionDeviceBindingProofV1(context);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
      privateKey, buffer(payload)));
    if (signature.byteLength !== 64 || !await crypto.subtle.verify("Ed25519",
      publicKey, buffer(signature), buffer(payload)))
      throw new BrowserDeviceBindingProofError();
    return { context, nonce, signature };
  } catch { throw new BrowserDeviceBindingProofError(); }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length)
    throw new BrowserDeviceBindingProofError();
  return Uint8Array.from(value);
}
