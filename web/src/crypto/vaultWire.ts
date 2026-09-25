import {
  MAX_VAULT_BYTES,
  VAULT_CHUNK_BYTES,
  VAULT_FORMAT,
  type EncryptedVaultBlob,
  type EncryptedVaultChunk,
} from "./vault.js";

const MAGIC = new Uint8Array([0x41, 0x44, 0x45, 0x4e]); // ADEN
const VERSION = 1;
const BLOB_ID_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHUNK_HEADER_BYTES = IV_BYTES + 4;
const HEADER_BYTES = MAGIC.length + 1 + BLOB_ID_BYTES + 4 + 4 + 4;
const MAX_CHUNKS = Math.ceil(MAX_VAULT_BYTES / VAULT_CHUNK_BYTES);
const MAX_WIRE_BYTES = HEADER_BYTES + MAX_VAULT_BYTES +
  MAX_CHUNKS * (CHUNK_HEADER_BYTES + TAG_BYTES);

export class VaultWireError extends Error {
  constructor() {
    super("This encrypted record has an invalid storage format.");
    this.name = "VaultWireError";
  }
}

function expectedChunkBytes(plaintextSize: number, index: number): number {
  return Math.max(0, Math.min(VAULT_CHUNK_BYTES,
    plaintextSize - index * VAULT_CHUNK_BYTES)) + TAG_BYTES;
}

function validBlobShape(blob: EncryptedVaultBlob): boolean {
  if (blob.format !== VAULT_FORMAT || !(blob.blobId instanceof Uint8Array) ||
    blob.blobId.byteLength !== BLOB_ID_BYTES ||
    !Number.isSafeInteger(blob.plaintextSize) || blob.plaintextSize < 0 ||
    blob.plaintextSize > MAX_VAULT_BYTES || blob.chunkSize !== VAULT_CHUNK_BYTES ||
    !Array.isArray(blob.chunks) ||
    blob.chunks.length !== Math.max(1, Math.ceil(blob.plaintextSize / VAULT_CHUNK_BYTES)))
    return false;
  return blob.chunks.every((chunk, index) =>
    chunk !== null && typeof chunk === "object" &&
    chunk.iv instanceof Uint8Array && chunk.iv.byteLength === IV_BYTES &&
    Object.prototype.toString.call(chunk.ciphertext) === "[object ArrayBuffer]" &&
    chunk.ciphertext.byteLength === expectedChunkBytes(blob.plaintextSize, index));
}

/** Encrypted content only; exact plaintext size and chunk count remain visible metadata. */
export function encodeVaultBlob(blob: EncryptedVaultBlob): Uint8Array {
  if (!blob || !validBlobShape(blob)) throw new VaultWireError();
  const size = HEADER_BYTES + blob.chunks.reduce((total, chunk) =>
    total + CHUNK_HEADER_BYTES + chunk.ciphertext.byteLength, 0);
  if (size > MAX_WIRE_BYTES) throw new VaultWireError();
  const wire = new Uint8Array(size);
  const view = new DataView(wire.buffer);
  wire.set(MAGIC, 0);
  wire[MAGIC.length] = VERSION;
  wire.set(blob.blobId, MAGIC.length + 1);
  view.setUint32(21, blob.plaintextSize);
  view.setUint32(25, VAULT_CHUNK_BYTES);
  view.setUint32(29, blob.chunks.length);
  let offset = HEADER_BYTES;
  for (const chunk of blob.chunks) {
    wire.set(chunk.iv, offset);
    offset += IV_BYTES;
    view.setUint32(offset, chunk.ciphertext.byteLength);
    offset += 4;
    wire.set(new Uint8Array(chunk.ciphertext), offset);
    offset += chunk.ciphertext.byteLength;
  }
  return wire;
}

/** Strictly parse one complete encrypted blob; never return partial chunks. */
export function decodeVaultBlob(wire: Uint8Array): EncryptedVaultBlob {
  if (!(wire instanceof Uint8Array) ||
    wire.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES + TAG_BYTES ||
    wire.byteLength > MAX_WIRE_BYTES ||
    MAGIC.some((byte, index) => wire[index] !== byte) ||
    wire[MAGIC.length] !== VERSION)
    throw new VaultWireError();
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
  const plaintextSize = view.getUint32(21);
  const chunkSize = view.getUint32(25);
  const chunkCount = view.getUint32(29);
  if (plaintextSize > MAX_VAULT_BYTES || chunkSize !== VAULT_CHUNK_BYTES ||
    chunkCount !== Math.max(1, Math.ceil(plaintextSize / VAULT_CHUNK_BYTES)))
    throw new VaultWireError();
  const chunks: EncryptedVaultChunk[] = [];
  let offset = HEADER_BYTES;
  for (let index = 0; index < chunkCount; index += 1) {
    if (offset + CHUNK_HEADER_BYTES > wire.byteLength) throw new VaultWireError();
    const iv = wire.slice(offset, offset + IV_BYTES);
    offset += IV_BYTES;
    const length = view.getUint32(offset);
    offset += 4;
    if (length !== expectedChunkBytes(plaintextSize, index) ||
      offset + length > wire.byteLength) throw new VaultWireError();
    const ciphertext = new ArrayBuffer(length);
    new Uint8Array(ciphertext).set(wire.subarray(offset, offset + length));
    chunks.push({ iv, ciphertext });
    offset += length;
  }
  if (offset !== wire.byteLength) throw new VaultWireError();
  const blobId = wire.slice(MAGIC.length + 1, MAGIC.length + 1 + BLOB_ID_BYTES);
  return { format: VAULT_FORMAT, blobId, plaintextSize, chunkSize, chunks };
}
