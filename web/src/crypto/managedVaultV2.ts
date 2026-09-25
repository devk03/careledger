import { MANAGED_VAULT_CHUNK_BYTES, MANAGED_VAULT_FORMAT_V2,
  MAX_MANAGED_VAULT_BYTES, assertManagedVaultBlobV2,
  type ManagedVaultBlobV2 } from "@adeno/contracts";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const BLOB_ID_BYTES = 16;
const IV_BYTES = 12;
const AAD_DOMAIN = new TextEncoder().encode("adeno:managed-blob:v2\0");
const SCOPE_KEYS = ["careProfileId", "householdId", "keyEpoch", "objectId",
  "opaqueScopeId", "purpose", "revision"];

export type ManagedVaultPurposeV2 = "day-snapshot" | "source-original" |
  "review-draft" | "encrypted-index";

/** No care date, filename, or clinical label may be placed in a hosted scope. */
export type ManagedVaultScopeV2 = {
  householdId: string;
  careProfileId: string;
  opaqueScopeId: string;
  objectId: string;
  keyEpoch: number;
  purpose: ManagedVaultPurposeV2;
  revision: number;
};

export class ManagedVaultIntegrityV2Error extends Error {
  constructor() {
    super("This encrypted record could not be verified or opened.");
    this.name = "ManagedVaultIntegrityV2Error";
  }
}

/**
 * Browser-only prototype. The caller must supply the separately authorized
 * day/source/draft key; this module does not grant access or reserve nonces.
 */
export async function encryptManagedVaultBlobV2(key: CryptoKey,
  input: Uint8Array, scope: ManagedVaultScopeV2,
  reservedBlobId?: Uint8Array): Promise<ManagedVaultBlobV2> {
  assertKey(key);
  const stableScope = snapshotScope(scope);
  if (!ArrayBuffer.isView(input) ||
    Object.prototype.toString.call(input) !== "[object Uint8Array]" ||
    input.byteLength > MAX_MANAGED_VAULT_BYTES)
    throw new ManagedVaultIntegrityV2Error();
  if (reservedBlobId !== undefined &&
    (Object.prototype.toString.call(reservedBlobId) !== "[object Uint8Array]" ||
      reservedBlobId.byteLength !== BLOB_ID_BYTES))
    throw new ManagedVaultIntegrityV2Error();
  // Copy before the first await: callers cannot swap the server-reserved ID
  // while encryption is in progress. It is bound into every chunk's AAD.
  const blobId = reservedBlobId === undefined ?
    crypto.getRandomValues(new Uint8Array(BLOB_ID_BYTES)) :
    Uint8Array.from(reservedBlobId);
  const plaintext = Uint8Array.from(input);
  try {
    const totalChunks = Math.max(1, Math.ceil(plaintext.byteLength / MANAGED_VAULT_CHUNK_BYTES));
    const seenIvs = new Set<string>();
    const chunks: ManagedVaultBlobV2["chunks"] = [];
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * MANAGED_VAULT_CHUNK_BYTES;
      const end = Math.min(start + MANAGED_VAULT_CHUNK_BYTES, plaintext.byteLength);
      let iv: Uint8Array;
      let identity: string;
      do {
        iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
        identity = hex(iv);
      } while (seenIvs.has(identity));
      seenIvs.add(identity);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
        additionalData: associatedData(stableScope, blobId, index, totalChunks,
          plaintext.byteLength), tagLength: 128 }, key, plaintext.subarray(start, end));
      chunks.push({ iv, ciphertext });
    }
    return { format: MANAGED_VAULT_FORMAT_V2, blobId,
      plaintextSize: plaintext.byteLength, chunkSize: MANAGED_VAULT_CHUNK_BYTES, chunks };
  } finally {
    plaintext.fill(0);
  }
}

/** Returns bytes only after every chunk has authenticated; never returns a partial record. */
export async function decryptManagedVaultBlobV2(key: CryptoKey,
  blob: ManagedVaultBlobV2, scope: ManagedVaultScopeV2): Promise<Uint8Array> {
  let plaintext: Uint8Array | null = null;
  try {
    assertKey(key);
    const stableScope = snapshotScope(scope);
    const stableBlob = snapshotBlob(blob);
    plaintext = new Uint8Array(stableBlob.plaintextSize);
    let written = 0;
    for (const [index, chunk] of stableBlob.chunks.entries()) {
      const bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM",
        iv: chunk.iv,
        additionalData: associatedData(stableScope, stableBlob.blobId, index,
          stableBlob.chunks.length, stableBlob.plaintextSize), tagLength: 128 },
      key, chunk.ciphertext));
      try {
        plaintext.set(bytes, written);
        written += bytes.byteLength;
      } finally { bytes.fill(0); }
    }
    if (written !== stableBlob.plaintextSize) throw new ManagedVaultIntegrityV2Error();
    return plaintext;
  } catch {
    plaintext?.fill(0);
    throw new ManagedVaultIntegrityV2Error();
  }
}

function snapshotBlob(blob: ManagedVaultBlobV2): ManagedVaultBlobV2 {
  assertManagedVaultBlobV2(blob);
  const stable: ManagedVaultBlobV2 = { format: MANAGED_VAULT_FORMAT_V2,
    blobId: Uint8Array.from(blob.blobId), plaintextSize: blob.plaintextSize,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: blob.chunks.map((chunk) => ({ iv: Uint8Array.from(chunk.iv),
      ciphertext: chunk.ciphertext.slice(0) })) };
  assertManagedVaultBlobV2(stable);
  return stable;
}

function assertKey(key: CryptoKey): void {
  if (!key || key.type !== "secret" || key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256 || key.extractable ||
    !key.usages.includes("encrypt") || !key.usages.includes("decrypt"))
    throw new ManagedVaultIntegrityV2Error();
}

function assertScope(scope: ManagedVaultScopeV2): void {
  if (!scope || typeof scope !== "object" ||
    !hasOnlyKeys(scope, SCOPE_KEYS) ||
    ![scope.householdId, scope.careProfileId, scope.opaqueScopeId,
      scope.objectId].every((value) => typeof value === "string" && OPAQUE_ID.test(value)) ||
    !Number.isSafeInteger(scope.keyEpoch) || scope.keyEpoch < 1 ||
    scope.keyEpoch > 0xffffffff || !Number.isSafeInteger(scope.revision) ||
    scope.revision < 1 || scope.revision > 0xffffffff ||
    !["day-snapshot", "source-original", "review-draft",
      "encrypted-index"].includes(scope.purpose))
    throw new ManagedVaultIntegrityV2Error();
}

function snapshotScope(scope: ManagedVaultScopeV2): ManagedVaultScopeV2 {
  assertScope(scope);
  const stable = { householdId: scope.householdId,
    careProfileId: scope.careProfileId, opaqueScopeId: scope.opaqueScopeId,
    objectId: scope.objectId, keyEpoch: scope.keyEpoch,
    purpose: scope.purpose, revision: scope.revision };
  assertScope(stable);
  return stable;
}

/** Canonical binary AAD; every field is fixed width and v1 has a different domain. */
function associatedData(scope: ManagedVaultScopeV2, blobId: Uint8Array,
  index: number, totalChunks: number, plaintextSize: number): Uint8Array {
  const aad = new Uint8Array(AAD_DOMAIN.byteLength + 4 * 16 + 4 + 1 + 4 +
    BLOB_ID_BYTES + 4 + 4 + 4);
  const view = new DataView(aad.buffer);
  aad.set(AAD_DOMAIN);
  let offset = AAD_DOMAIN.byteLength;
  for (const id of [scope.householdId, scope.careProfileId,
    scope.opaqueScopeId, scope.objectId]) {
    aad.set(fromHex(id), offset);
    offset += 16;
  }
  view.setUint32(offset, scope.keyEpoch, false);
  offset += 4;
  aad[offset] = scope.purpose === "day-snapshot" ? 1 :
    scope.purpose === "source-original" ? 2 :
    scope.purpose === "review-draft" ? 3 : 4;
  offset += 1;
  view.setUint32(offset, scope.revision, false);
  offset += 4;
  aad.set(blobId, offset);
  offset += BLOB_ID_BYTES;
  view.setUint32(offset, index, false);
  offset += 4;
  view.setUint32(offset, totalChunks, false);
  offset += 4;
  view.setUint32(offset, plaintextSize, false);
  return aad;
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function hex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
