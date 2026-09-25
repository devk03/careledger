export const VAULT_FORMAT = "careledger.e2ee.v1" as const;
export const VAULT_CHUNK_BYTES = 1024 * 1024;
const VAULT_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const BLOB_ID_BYTES = 16;
const GCM_TAG_BYTES = 16;
export const MAX_VAULT_BYTES = 100 * 1024 * 1024;

export interface VaultScope {
  householdId: string;
  objectId: string;
  revision: number;
}

export interface EncryptedVaultChunk {
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface EncryptedVaultBlob {
  format: typeof VAULT_FORMAT;
  blobId: Uint8Array;
  plaintextSize: number;
  chunkSize: number;
  chunks: EncryptedVaultChunk[];
}

export class VaultIntegrityError extends Error {
  constructor() {
    super("This encrypted record could not be verified or opened.");
    this.name = "VaultIntegrityError";
  }
}

export function generateVaultKeyMaterial(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(VAULT_KEY_BYTES));
}

export async function importVaultKey(keyMaterial: Uint8Array): Promise<CryptoKey> {
  if (keyMaterial.byteLength !== VAULT_KEY_BYTES) {
    throw new Error("An adeno vault key must contain 256 bits.");
  }
  return crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptVaultBlob(
  key: CryptoKey,
  plaintext: Uint8Array,
  scope: VaultScope,
): Promise<EncryptedVaultBlob> {
  assertVaultKey(key);
  assertScope(scope);
  if (plaintext.byteLength > MAX_VAULT_BYTES) {
    throw new Error("This record is larger than the encrypted vault limit.");
  }
  const totalChunks = Math.max(1, Math.ceil(plaintext.byteLength / VAULT_CHUNK_BYTES));
  const blobId = crypto.getRandomValues(new Uint8Array(BLOB_ID_BYTES));
  const chunks: EncryptedVaultChunk[] = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const start = index * VAULT_CHUNK_BYTES;
    const end = Math.min(start + VAULT_CHUNK_BYTES, plaintext.byteLength);
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const additionalData = chunkAssociatedData(scope, blobId, {
      index,
      totalChunks,
      plaintextSize: plaintext.byteLength,
    });
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      plaintext.subarray(start, end),
    );
    chunks.push({ iv, ciphertext });
  }
  return {
    format: VAULT_FORMAT,
    blobId,
    plaintextSize: plaintext.byteLength,
    chunkSize: VAULT_CHUNK_BYTES,
    chunks,
  };
}

export async function decryptVaultBlob(
  key: CryptoKey,
  encrypted: EncryptedVaultBlob,
  scope: VaultScope,
): Promise<Uint8Array> {
  let plaintext: Uint8Array | null = null;
  try {
    assertVaultKey(key);
    assertScope(scope);
    const expectedChunks = Math.max(
      1,
      Math.ceil(encrypted.plaintextSize / VAULT_CHUNK_BYTES),
    );
    if (
      encrypted.format !== VAULT_FORMAT ||
      !(encrypted.blobId instanceof Uint8Array) ||
      encrypted.blobId.byteLength !== BLOB_ID_BYTES ||
      encrypted.chunkSize !== VAULT_CHUNK_BYTES ||
      !Number.isSafeInteger(encrypted.plaintextSize) ||
      encrypted.plaintextSize < 0 ||
      encrypted.plaintextSize > MAX_VAULT_BYTES ||
      encrypted.chunks.length !== expectedChunks
    ) {
      throw new VaultIntegrityError();
    }
    plaintext = new Uint8Array(encrypted.plaintextSize);
    let offset = 0;
    for (const [index, chunk] of encrypted.chunks.entries()) {
      const expectedPlaintextBytes = Math.max(
        0,
        Math.min(
          VAULT_CHUNK_BYTES,
          encrypted.plaintextSize - index * VAULT_CHUNK_BYTES,
        ),
      );
      if (
        !(chunk.iv instanceof Uint8Array) ||
        chunk.iv.byteLength !== GCM_IV_BYTES ||
        !isArrayBuffer(chunk.ciphertext) ||
        chunk.ciphertext.byteLength !== expectedPlaintextBytes + GCM_TAG_BYTES
      ) {
        throw new VaultIntegrityError();
      }
      const additionalData = chunkAssociatedData(scope, encrypted.blobId, {
        index,
        totalChunks: expectedChunks,
        plaintextSize: encrypted.plaintextSize,
      });
      const decrypted = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: chunk.iv, additionalData, tagLength: 128 },
          key,
          chunk.ciphertext,
        ),
      );
      if (offset + decrypted.byteLength > plaintext.byteLength) {
        throw new VaultIntegrityError();
      }
      plaintext.set(decrypted, offset);
      offset += decrypted.byteLength;
      decrypted.fill(0);
    }
    if (offset !== plaintext.byteLength) {
      throw new VaultIntegrityError();
    }
    return plaintext;
  } catch (error) {
    plaintext?.fill(0);
    if (error instanceof VaultIntegrityError) throw error;
    throw new VaultIntegrityError();
  }
}

function assertVaultKey(key: CryptoKey): void {
  if (
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256 ||
    key.extractable ||
    !key.usages.includes("encrypt") ||
    !key.usages.includes("decrypt")
  ) {
    throw new Error("adeno requires a non-exportable AES-GCM vault key.");
  }
}

function assertScope(scope: VaultScope): void {
  for (const value of [scope.householdId, scope.objectId]) {
    const hasControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    });
    if (!value || value.length > 256 || hasControlCharacter) {
      throw new Error("Encrypted record scope is invalid.");
    }
  }
  if (!Number.isSafeInteger(scope.revision) || scope.revision < 1) {
    throw new Error("Encrypted record revision is invalid.");
  }
}

function chunkAssociatedData(
  scope: VaultScope,
  blobId: Uint8Array,
  chunk: { index: number; totalChunks: number; plaintextSize: number },
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      format: VAULT_FORMAT,
      blobId: base64Url(blobId),
      householdId: scope.householdId,
      objectId: scope.objectId,
      revision: scope.revision,
      index: chunk.index,
      totalChunks: chunk.totalChunks,
      plaintextSize: chunk.plaintextSize,
    }),
  );
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}
