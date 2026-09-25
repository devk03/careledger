import { decodeManagedVaultBlobV2, decodeSignedIndexHead,
  encodeIndexHeadHeader, encodeSignedIndexHead, INDEX_HEAD_FORMAT,
  INDEX_HEAD_WIRE_BYTES, MAX_MANAGED_VAULT_WIRE_BYTES,
  ZERO_HEAD_SHA256, type IndexHeadContext } from "@adeno/contracts";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HEAD_HASH_DOMAIN = new TextEncoder().encode("adeno:index-head-hash:v1\0");
const U64_MAX = (1n << 64n) - 1n;

export type IndexViewIdentity = {
  householdId: string;
  careProfileId: string;
  viewId: string;
  indexKeyId: string;
  keyEpoch: number;
};

/** Persist only after the corresponding index decrypts and validates completely. */
export type IndexHeadCandidate = {
  householdId: string;
  careProfileId: string;
  viewId: string;
  indexKeyId: string;
  keyEpoch: number;
  sequence: bigint;
  headSha256: string;
};

/** Must originate from local trusted state or an independent authenticated witness. */
export type TrustedIndexCheckpoint = IndexHeadCandidate;

export class IndexHeadIntegrityError extends Error {
  constructor() {
    super("The encrypted timeline head could not be verified.");
    this.name = "IndexHeadIntegrityError";
  }
}

/** Browser-only signing identity; enrollment and persistence are separate protocols. */
export async function generateIndexSigningKeys(): Promise<CryptoKeyPair> {
  try {
    const pair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
    if (!("privateKey" in pair) || pair.privateKey.extractable)
      throw new IndexHeadIntegrityError();
    return pair;
  } catch { throw new IndexHeadIntegrityError(); }
}

/**
 * Signs one local candidate. This does not publish an index or establish that
 * the signer is enrolled, authorized, or showing the latest state to others.
 */
export async function signLocalIndexHead(input: {
  identity: IndexViewIdentity;
  objectId: string;
  authorDeviceId: string;
  authorCounter: bigint;
  grantHeadSha256: string;
  ciphertextWire: Uint8Array;
  signingKeys: CryptoKeyPair;
  previous: TrustedIndexCheckpoint | null;
}): Promise<{ wire: Uint8Array; candidate: IndexHeadCandidate }> {
  try {
    const identity = snapshotIdentity(input.identity);
    const previous = input.previous === null ? null : snapshotCheckpoint(input.previous);
    if (previous && !sameView(identity, previous)) throw new IndexHeadIntegrityError();
    const objectId = input.objectId;
    const authorDeviceId = input.authorDeviceId;
    const authorCounter = input.authorCounter;
    const grantHeadSha256 = input.grantHeadSha256;
    const publicKey = input.signingKeys.publicKey;
    const privateKey = input.signingKeys.privateKey;
    if (!OPAQUE_ID.test(objectId) || !OPAQUE_ID.test(authorDeviceId) ||
      !SHA256.test(grantHeadSha256) ||
      typeof authorCounter !== "bigint" || authorCounter < 1n ||
      authorCounter > U64_MAX) throw new IndexHeadIntegrityError();
    const ciphertext = snapshotCiphertext(input.ciphertextWire);
    assertSigningKey(privateKey);
    assertVerifyKey(publicKey);
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
    if (publicRaw.byteLength !== 32) throw new IndexHeadIntegrityError();
    const sequence = previous ? previous.sequence + 1n : 1n;
    if (sequence > U64_MAX) throw new IndexHeadIntegrityError();
    const context: IndexHeadContext = { ...identity,
      objectId, authorDeviceId, authorCounter, sequence,
      previousHeadSha256: previous?.headSha256 ?? ZERO_HEAD_SHA256,
      ciphertextByteLength: ciphertext.byteLength,
      ciphertextSha256: await sha256Hex(ciphertext),
      grantHeadSha256,
      signingKeySha256: await sha256Hex(publicRaw) };
    const header = encodeIndexHeadHeader(context);
    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey,
      toArrayBuffer(header)));
    const wire = encodeSignedIndexHead({ format: INDEX_HEAD_FORMAT, context, signature });
    if (!await crypto.subtle.verify("Ed25519", publicKey,
      toArrayBuffer(signature), toArrayBuffer(header))) throw new IndexHeadIntegrityError();
    return { wire, candidate: { householdId: identity.householdId,
      careProfileId: identity.careProfileId, viewId: identity.viewId,
      indexKeyId: identity.indexKeyId, keyEpoch: identity.keyEpoch,
      sequence, headSha256: await headHash(wire) } };
  } catch { throw new IndexHeadIntegrityError(); }
}

/**
 * Relative rollback/fork check only. A host can withhold never-seen newer heads;
 * a fresh device without an independently trusted checkpoint cannot use this.
 * The caller must authenticate signer enrollment/grant and validate decrypted
 * index contents before persisting the returned candidate as a checkpoint.
 */
export async function verifyIndexHeadCandidate(input: {
  wire: Uint8Array;
  ciphertextWire: Uint8Array;
  expectedView: IndexViewIdentity;
  trustedSigner: { deviceId: string; publicKey: CryptoKey };
  trustedGrantHeadSha256: string;
  checkpoint: TrustedIndexCheckpoint;
}): Promise<{ state: "unchanged" | "advanced";
  candidate: IndexHeadCandidate }> {
  try {
    const wire = snapshotBytes(input.wire, INDEX_HEAD_WIRE_BYTES,
      INDEX_HEAD_WIRE_BYTES);
    const ciphertext = snapshotCiphertext(input.ciphertextWire);
    const expected = snapshotIdentity(input.expectedView);
    const checkpoint = snapshotCheckpoint(input.checkpoint);
    const signer = { deviceId: input.trustedSigner.deviceId,
      publicKey: input.trustedSigner.publicKey };
    const trustedGrantHeadSha256 = input.trustedGrantHeadSha256;
    const head = decodeSignedIndexHead(wire);
    const context = head.context;
    assertVerifyKey(signer.publicKey);
    if (!sameView(expected, checkpoint) ||
      context.householdId !== expected.householdId ||
      context.careProfileId !== expected.careProfileId ||
      context.viewId !== expected.viewId ||
      context.indexKeyId !== expected.indexKeyId ||
      context.keyEpoch !== expected.keyEpoch ||
      context.authorDeviceId !== signer.deviceId ||
      !OPAQUE_ID.test(signer.deviceId) ||
      !SHA256.test(trustedGrantHeadSha256) ||
      context.grantHeadSha256 !== trustedGrantHeadSha256 ||
      context.ciphertextByteLength !== ciphertext.byteLength ||
      context.ciphertextSha256 !== await sha256Hex(ciphertext))
      throw new IndexHeadIntegrityError();
    const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", signer.publicKey));
    if (publicRaw.byteLength !== 32 ||
      context.signingKeySha256 !== await sha256Hex(publicRaw) ||
      !await crypto.subtle.verify("Ed25519", signer.publicKey,
        toArrayBuffer(head.signature), toArrayBuffer(encodeIndexHeadHeader(context))))
      throw new IndexHeadIntegrityError();
    const candidate: IndexHeadCandidate = { householdId: context.householdId,
      careProfileId: context.careProfileId, viewId: context.viewId,
      indexKeyId: context.indexKeyId, keyEpoch: context.keyEpoch,
      sequence: context.sequence, headSha256: await headHash(wire) };
    if (candidate.sequence === checkpoint.sequence &&
      candidate.headSha256 === checkpoint.headSha256)
      return { state: "unchanged", candidate };
    if (candidate.sequence !== checkpoint.sequence + 1n ||
      context.previousHeadSha256 !== checkpoint.headSha256)
      throw new IndexHeadIntegrityError();
    return { state: "advanced", candidate };
  } catch { throw new IndexHeadIntegrityError(); }
}

function snapshotIdentity(identity: IndexViewIdentity): IndexViewIdentity {
  if (!identity || ![identity.householdId, identity.careProfileId,
    identity.viewId, identity.indexKeyId].every((id) =>
    typeof id === "string" && OPAQUE_ID.test(id)) ||
    !Number.isSafeInteger(identity.keyEpoch) || identity.keyEpoch < 1 ||
    identity.keyEpoch > 0xffffffff) throw new IndexHeadIntegrityError();
  return { householdId: identity.householdId, careProfileId: identity.careProfileId,
    viewId: identity.viewId, indexKeyId: identity.indexKeyId,
    keyEpoch: identity.keyEpoch };
}

function snapshotCheckpoint(value: TrustedIndexCheckpoint): TrustedIndexCheckpoint {
  if (!value || ![value.householdId, value.careProfileId, value.viewId,
    value.indexKeyId]
    .every((id) => typeof id === "string" && OPAQUE_ID.test(id)) ||
    !Number.isSafeInteger(value.keyEpoch) || value.keyEpoch < 1 ||
    value.keyEpoch > 0xffffffff ||
    typeof value.sequence !== "bigint" || value.sequence < 1n ||
    value.sequence > U64_MAX || typeof value.headSha256 !== "string" ||
    !SHA256.test(value.headSha256)) throw new IndexHeadIntegrityError();
  return { householdId: value.householdId, careProfileId: value.careProfileId,
    viewId: value.viewId, indexKeyId: value.indexKeyId,
    keyEpoch: value.keyEpoch, sequence: value.sequence,
    headSha256: value.headSha256 };
}

function sameView(a: IndexViewIdentity, b: TrustedIndexCheckpoint): boolean {
  return a.householdId === b.householdId && a.careProfileId === b.careProfileId &&
    a.viewId === b.viewId && a.indexKeyId === b.indexKeyId &&
    a.keyEpoch === b.keyEpoch;
}

function snapshotCiphertext(input: Uint8Array): Uint8Array {
  const copy = snapshotBytes(input, 65, MAX_MANAGED_VAULT_WIRE_BYTES);
  decodeManagedVaultBlobV2(copy); // Framing only; AES-GCM authenticity requires device decryption.
  return copy;
}

function snapshotBytes(input: Uint8Array, minimum: number, maximum: number): Uint8Array {
  if (!ArrayBuffer.isView(input) ||
    Object.prototype.toString.call(input) !== "[object Uint8Array]" ||
    input.byteLength < minimum || input.byteLength > maximum)
    throw new IndexHeadIntegrityError();
  return Uint8Array.from(input);
}

function assertSigningKey(key: CryptoKey): void {
  if (!key || key.type !== "private" || key.algorithm.name !== "Ed25519" ||
    key.extractable || !key.usages.includes("sign")) throw new IndexHeadIntegrityError();
}

function assertVerifyKey(key: CryptoKey): void {
  if (!key || key.type !== "public" || key.algorithm.name !== "Ed25519" ||
    !key.usages.includes("verify")) throw new IndexHeadIntegrityError();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))));
}

async function headHash(wire: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(HEAD_HASH_DOMAIN.byteLength + wire.byteLength);
  bytes.set(HEAD_HASH_DOMAIN);
  bytes.set(wire, HEAD_HASH_DOMAIN.byteLength);
  return sha256Hex(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function hex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}
