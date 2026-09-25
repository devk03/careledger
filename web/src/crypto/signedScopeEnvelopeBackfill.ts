import { decodeScopeKeyEnvelopeV2, encodeScopeEnvelopeBackfillPayloadV1,
  SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1,
  type ScopeEnvelopeBackfillActionContextV1 } from "@adeno/contracts";

const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;

export class SignedScopeEnvelopeBackfillError extends Error {
  constructor() {
    super("The historical scope-key action could not be signed.");
    this.name = "SignedScopeEnvelopeBackfillError";
  }
}

/** This signs claims; enrollment, permission and latest-state freshness are separate. */
export async function signScopeEnvelopeBackfill(input: {
  envelopeWire: Uint8Array;
  recipientEncryptionPublicKey: Uint8Array;
  historicalActivationSequence: bigint;
  historicalActivationSha256: string;
  currentActiveKeySequence: bigint;
  currentActiveKeyHeadSha256: string;
  currentGrantSequence: bigint;
  currentGrantHeadSha256: string;
  issuerDeviceId: string;
  issuerCounter: bigint;
  sessionId: string;
  createdAt: bigint;
  previousActionSha256: string | null;
  signingKeys: CryptoKeyPair;
}): Promise<{ context: ScopeEnvelopeBackfillActionContextV1;
  payloadSha256: string; actionSha256: string; signature: Uint8Array }> {
  try {
    const wire = copyBytes(input.envelopeWire, 240);
    const recipientPublic = copyBytes(input.recipientEncryptionPublicKey, 32);
    const claims = {
      historicalActivationSequence: input.historicalActivationSequence,
      historicalActivationSha256: input.historicalActivationSha256,
      currentActiveKeySequence: input.currentActiveKeySequence,
      activeKeyHeadSha256: input.currentActiveKeyHeadSha256,
      currentGrantSequence: input.currentGrantSequence,
      grantHeadSha256: input.currentGrantHeadSha256,
      issuerDeviceId: input.issuerDeviceId,
      issuerCounter: input.issuerCounter,
      sessionId: input.sessionId,
      createdAt: input.createdAt,
      previousActionSha256: input.previousActionSha256,
    };
    const publicKey = input.signingKeys.publicKey;
    const privateKey = input.signingKeys.privateKey;
    if (!privateKey || privateKey.type !== "private" ||
      privateKey.algorithm.name !== "Ed25519" || privateKey.extractable ||
      !privateKey.usages.includes("sign") ||
      !publicKey || publicKey.type !== "public" ||
      publicKey.algorithm.name !== "Ed25519" ||
      !publicKey.usages.includes("verify"))
      throw new SignedScopeEnvelopeBackfillError();
    const envelope = decodeScopeKeyEnvelopeV2(wire);
    const signingPublic = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    if (signingPublic.byteLength !== 32) throw new SignedScopeEnvelopeBackfillError();
    const recipientKeySha256 = await sha256Hex(recipientPublic);
    if (recipientKeySha256 !== envelope.recipientKeySha256)
      throw new SignedScopeEnvelopeBackfillError();
    const context: ScopeEnvelopeBackfillActionContextV1 = {
      ...envelope.context,
      keyCommitmentSha256: envelope.keyCommitmentSha256,
      recipientKeySha256,
      wireSha256: await sha256Hex(wire),
      issuerSigningKeySha256: await sha256Hex(signingPublic),
      ...claims,
    };
    const payload = encodeScopeEnvelopeBackfillPayloadV1(context);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
      privateKey, buffer(payload)));
    if (signature.byteLength !== 64 || !await crypto.subtle.verify("Ed25519",
      publicKey, buffer(signature), buffer(payload)))
      throw new SignedScopeEnvelopeBackfillError();
    return { context, payloadSha256: await sha256Hex(payload),
      actionSha256: await sha256Hex(actionHashMessage(payload, signature)),
      signature };
  } catch { throw new SignedScopeEnvelopeBackfillError(); }
}

function actionHashMessage(payload: Uint8Array, signature: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1);
  const message = new Uint8Array(domain.byteLength + payload.byteLength + signature.byteLength);
  message.set(domain);
  message.set(payload, domain.byteLength);
  message.set(signature, domain.byteLength + payload.byteLength);
  return message;
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
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" || value.byteLength !== length)
    throw new SignedScopeEnvelopeBackfillError();
  return Uint8Array.from(value);
}
