/** Opaque encrypted-blob framing only. A valid frame is not proof of encryption or access. */
export const MANAGED_VAULT_FORMAT_V2 = "adeno.managed-vault.v2" as const;
export const MANAGED_VAULT_WIRE_VERSION = 2;
export const MANAGED_VAULT_CHUNK_BYTES = 1024 * 1024;
export const MAX_MANAGED_VAULT_BYTES = 100 * MANAGED_VAULT_CHUNK_BYTES;

const MAGIC = new Uint8Array([0x41, 0x44, 0x45, 0x4e]); // ADEN
const BLOB_ID_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 33;
const CHUNK_HEADER_BYTES = IV_BYTES + 4;
const MAX_CHUNKS = MAX_MANAGED_VAULT_BYTES / MANAGED_VAULT_CHUNK_BYTES;
const MAX_WIRE_BYTES = HEADER_BYTES + MAX_MANAGED_VAULT_BYTES +
  MAX_CHUNKS * (CHUNK_HEADER_BYTES + TAG_BYTES);

export type ManagedVaultChunkV2 = { iv: Uint8Array; ciphertext: ArrayBuffer };
export type ManagedVaultBlobV2 = {
  format: typeof MANAGED_VAULT_FORMAT_V2;
  blobId: Uint8Array;
  plaintextSize: number;
  chunkSize: typeof MANAGED_VAULT_CHUNK_BYTES;
  chunks: ManagedVaultChunkV2[];
};

export class ManagedVaultWireV2Error extends Error {
  constructor() {
    super("This encrypted record has an invalid v2 storage format.");
    this.name = "ManagedVaultWireV2Error";
  }
}

export function assertManagedVaultBlobV2(blob: ManagedVaultBlobV2): void {
  if (!blob || blob.format !== MANAGED_VAULT_FORMAT_V2 ||
    !isBytes(blob.blobId) || blob.blobId.byteLength !== BLOB_ID_BYTES ||
    !Number.isSafeInteger(blob.plaintextSize) || blob.plaintextSize < 0 ||
    blob.plaintextSize > MAX_MANAGED_VAULT_BYTES ||
    blob.chunkSize !== MANAGED_VAULT_CHUNK_BYTES ||
    !Array.isArray(blob.chunks) ||
    blob.chunks.length !== Math.max(1,
      Math.ceil(blob.plaintextSize / MANAGED_VAULT_CHUNK_BYTES)))
    throw new ManagedVaultWireV2Error();
  const seenIvs = new Set<string>();
  for (const [index, chunk] of blob.chunks.entries()) {
    if (!chunk || !isBytes(chunk.iv) || chunk.iv.byteLength !== IV_BYTES ||
      Object.prototype.toString.call(chunk.ciphertext) !== "[object ArrayBuffer]" ||
      chunk.ciphertext.byteLength !== expectedChunkBytes(blob.plaintextSize, index))
      throw new ManagedVaultWireV2Error();
    const iv = hex(chunk.iv);
    if (seenIvs.has(iv)) throw new ManagedVaultWireV2Error();
    seenIvs.add(iv);
  }
}

/** Exact-length, versioned framing. Care dates, filenames, scope IDs and keys are absent. */
export function encodeManagedVaultBlobV2(blob: ManagedVaultBlobV2): Uint8Array {
  assertManagedVaultBlobV2(blob);
  const size = HEADER_BYTES + blob.chunks.reduce((total, chunk) =>
    total + CHUNK_HEADER_BYTES + chunk.ciphertext.byteLength, 0);
  if (size > MAX_WIRE_BYTES) throw new ManagedVaultWireV2Error();
  const wire = new Uint8Array(size);
  const view = new DataView(wire.buffer);
  wire.set(MAGIC);
  wire[4] = MANAGED_VAULT_WIRE_VERSION;
  wire.set(blob.blobId, 5);
  view.setUint32(21, blob.plaintextSize, false);
  view.setUint32(25, MANAGED_VAULT_CHUNK_BYTES, false);
  view.setUint32(29, blob.chunks.length, false);
  let offset = HEADER_BYTES;
  for (const chunk of blob.chunks) {
    wire.set(chunk.iv, offset);
    offset += IV_BYTES;
    view.setUint32(offset, chunk.ciphertext.byteLength, false);
    offset += 4;
    wire.set(new Uint8Array(chunk.ciphertext), offset);
    offset += chunk.ciphertext.byteLength;
  }
  return wire;
}

/** Strict framing only; returns copies so a caller cannot mutate parsed bytes via the input. */
export function decodeManagedVaultBlobV2(input: Uint8Array): ManagedVaultBlobV2 {
  if (!isBytes(input) || input.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES + TAG_BYTES ||
    input.byteLength > MAX_WIRE_BYTES) throw new ManagedVaultWireV2Error();
  const wire = Uint8Array.from(input);
  if (MAGIC.some((byte, index) => wire[index] !== byte) ||
    wire[4] !== MANAGED_VAULT_WIRE_VERSION) throw new ManagedVaultWireV2Error();
  const view = new DataView(wire.buffer);
  const plaintextSize = view.getUint32(21, false);
  const chunkSize = view.getUint32(25, false);
  const chunkCount = view.getUint32(29, false);
  if (plaintextSize > MAX_MANAGED_VAULT_BYTES ||
    chunkSize !== MANAGED_VAULT_CHUNK_BYTES ||
    chunkCount !== Math.max(1, Math.ceil(plaintextSize / MANAGED_VAULT_CHUNK_BYTES)))
    throw new ManagedVaultWireV2Error();
  const chunks: ManagedVaultChunkV2[] = [];
  const seenIvs = new Set<string>();
  let offset = HEADER_BYTES;
  for (let index = 0; index < chunkCount; index += 1) {
    if (offset + CHUNK_HEADER_BYTES > wire.byteLength) throw new ManagedVaultWireV2Error();
    const iv = wire.slice(offset, offset + IV_BYTES);
    const ivId = hex(iv);
    if (seenIvs.has(ivId)) throw new ManagedVaultWireV2Error();
    seenIvs.add(ivId);
    offset += IV_BYTES;
    const size = view.getUint32(offset, false);
    offset += 4;
    if (size !== expectedChunkBytes(plaintextSize, index) ||
      offset + size > wire.byteLength) throw new ManagedVaultWireV2Error();
    const ciphertext = new ArrayBuffer(size);
    new Uint8Array(ciphertext).set(wire.subarray(offset, offset + size));
    chunks.push({ iv, ciphertext });
    offset += size;
  }
  if (offset !== wire.byteLength) throw new ManagedVaultWireV2Error();
  return { format: MANAGED_VAULT_FORMAT_V2, blobId: wire.slice(5, 21),
    plaintextSize, chunkSize: MANAGED_VAULT_CHUNK_BYTES, chunks };
}

function expectedChunkBytes(plaintextSize: number, index: number): number {
  return Math.max(0, Math.min(MANAGED_VAULT_CHUNK_BYTES,
    plaintextSize - index * MANAGED_VAULT_CHUNK_BYTES)) + TAG_BYTES;
}

function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function hex(value: Uint8Array): string {
  let result = "";
  for (const byte of value) result += byte.toString(16).padStart(2, "0");
  return result;
}
