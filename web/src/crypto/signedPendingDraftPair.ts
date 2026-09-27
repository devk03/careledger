import { decodeManagedVaultBlobV2,
  encodePendingDraftPairActionPayloadV1,
  PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1,
  type PendingDraftPairActionContextV1 } from "@adeno/contracts";
import { openLocalEncryptedDraft, type LocalOpenedDraft } from
  "../managed/intakeDraft";
import { openScopeKeyEnvelopeV2, type ScopeKeyEnvelopeV2 } from
  "./scopeKeyEnvelopeV2";

const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
const MAX_CONTENT_WIRE_BYTES = 33 + 16 * 1024 * 1024 + 32 * 16;
const MAX_METADATA_WIRE_BYTES = 32 * 1024;

type Claims = Omit<PendingDraftPairActionContextV1,
  "contentWireSha256" | "metadataWireSha256" | "contentWireBytes" |
  "metadataWireBytes" | "issuerSigningKeySha256">;

export class SignedPendingDraftPairError extends Error {
  constructor() {
    super("The pending encrypted draft pair could not be signed.");
    this.name = "SignedPendingDraftPairError";
  }
}

/**
 * Device-only attestation of an authenticated content/metadata draft pair.
 * This does not establish current server grants, receipt durability or adult
 * approval.
 * The caller must compare both wire digests with authenticated upload receipts
 * and preserve the returned payload for later independent signature audit.
 */
export async function signPendingDraftPair(input: {
  claims: Claims;
  contentWire: Uint8Array;
  metadataWire: Uint8Array;
  draftKeyEnvelope: ScopeKeyEnvelopeV2;
  recipientEncryptionKeys: CryptoKeyPair;
  signingKeys: CryptoKeyPair;
}): Promise<{ context: PendingDraftPairActionContextV1;
  payload: Uint8Array; payloadSha256: string; actionSha256: string;
  signature: Uint8Array }> {
  let opened: LocalOpenedDraft | null = null;
  try {
    const claims = { ...input.claims };
    const contentWire = copyWire(input.contentWire, MAX_CONTENT_WIRE_BYTES);
    const metadataWire = copyWire(input.metadataWire, MAX_METADATA_WIRE_BYTES);
    const publicKey = input.signingKeys?.publicKey;
    const privateKey = input.signingKeys?.privateKey;
    const draftKey = await openScopeKeyEnvelopeV2({
      householdId: claims.householdId,
      careProfileId: claims.careProfileId,
      opaqueScopeId: claims.opaqueDraftScopeId,
      keyId: claims.keyId,
      keyEpoch: claims.keyEpoch,
      purpose: "draft",
      recipientDeviceId: claims.authorDeviceId,
      keyCommitmentSha256: claims.keyCommitmentSha256,
    }, input.draftKeyEnvelope, input.recipientEncryptionKeys);
    const content = decodeManagedVaultBlobV2(contentWire);
    const metadata = decodeManagedVaultBlobV2(metadataWire);
    if (hex(content.blobId) !== claims.contentBlobId ||
      hex(metadata.blobId) !== claims.metadataBlobId)
      throw new SignedPendingDraftPairError();
    opened = await openLocalEncryptedDraft({
      identity: { householdId: claims.householdId,
        careProfileId: claims.careProfileId,
        opaqueDraftId: claims.opaqueDraftScopeId,
        keyEpoch: claims.keyEpoch },
      key: draftKey,
      draft: { opaqueDraftId: claims.opaqueDraftScopeId,
        contentObjectId: claims.contentObjectId,
        metadataObjectId: claims.metadataObjectId,
        contentBlobId: claims.contentBlobId,
        metadataBlobId: claims.metadataBlobId,
        contentWire, metadataWire },
    });
    if (opened.kind === "file") opened.content.fill(0);
    opened = null;
    if (!privateKey || privateKey.type !== "private" ||
      privateKey.algorithm.name !== "Ed25519" || privateKey.extractable ||
      !privateKey.usages.includes("sign") || !publicKey ||
      publicKey.type !== "public" ||
      publicKey.algorithm.name !== "Ed25519" ||
      !publicKey.usages.includes("verify"))
      throw new SignedPendingDraftPairError();
    const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw",
      publicKey));
    if (rawPublic.byteLength !== 32) throw new SignedPendingDraftPairError();
    const context: PendingDraftPairActionContextV1 = {
      ...claims,
      contentWireBytes: contentWire.byteLength,
      metadataWireBytes: metadataWire.byteLength,
      contentWireSha256: await sha256Hex(contentWire),
      metadataWireSha256: await sha256Hex(metadataWire),
      issuerSigningKeySha256: await sha256Hex(rawPublic),
    };
    const payload = encodePendingDraftPairActionPayloadV1(context);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
      privateKey, buffer(payload)));
    if (signature.byteLength !== 64 ||
      !await crypto.subtle.verify("Ed25519", publicKey,
        buffer(signature), buffer(payload)))
      throw new SignedPendingDraftPairError();
    return { context, payload,
      payloadSha256: await sha256Hex(payload),
      actionSha256: await sha256Hex(actionHashMessage(payload, signature)),
      signature };
  } catch { throw new SignedPendingDraftPairError(); }
  finally { if (opened?.kind === "file") opened.content.fill(0); }
}

function actionHashMessage(payload: Uint8Array,
  signature: Uint8Array): Uint8Array {
  const domain = new TextEncoder().encode(
    PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1);
  const output = new Uint8Array(domain.byteLength + payload.byteLength +
    signature.byteLength);
  output.set(domain);
  output.set(payload, domain.byteLength);
  output.set(signature, domain.byteLength + payload.byteLength);
  return output;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",
    buffer(value))));
}

function buffer(value: Uint8Array): ArrayBuffer {
  const output = new ArrayBuffer(value.byteLength);
  new Uint8Array(output).set(value);
  return output;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function copyWire(value: Uint8Array, maximum: number): Uint8Array {
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" || value.byteLength < 65 ||
    value.byteLength > maximum) throw new SignedPendingDraftPairError();
  return Uint8Array.from(value);
}
