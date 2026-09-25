import { createHash } from "node:crypto";

import { MANAGED_VAULT_CHUNK_BYTES, MANAGED_VAULT_WIRE_VERSION,
  MAX_MANAGED_VAULT_BYTES } from "@adeno/contracts";

import { CiphertextObjectIntegrityError, readCiphertextChunk } from
  "./ciphertextObjectStore.js";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const WIRE_HEADER_BYTES = 33;
const CHUNK_HEADER_BYTES = 16;
const GCM_TAG_BYTES = 16;

export type StagedCiphertextChunk = {
  index: number;
  iv: Uint8Array;
  storageObjectId: string;
  sha256: string;
  byteSize: number;
};

export type CiphertextCommitProof = {
  wireSha256: string;
  wireBytes: number;
  chunkCount: number;
};

/**
 * Re-hash private objects and the exact v2 wire before a database commit.
 * This proves object integrity and framing, not AES-GCM validity or authority.
 * A commit transaction must still recheck the session, intent, grant and nonce
 * reservations, and copy these verified object IDs/digests into immutable rows.
 */
export async function proveStoredCiphertextWire(input: {
  root: string;
  householdId: string;
  blobId: string;
  plaintextBytes: number;
  expectedWireSha256: string;
  expectedWireBytes: number;
  chunks: readonly StagedCiphertextChunk[];
  signal?: AbortSignal;
}): Promise<CiphertextCommitProof> {
  const { root, householdId, blobId, plaintextBytes, expectedWireSha256,
    expectedWireBytes, chunks, signal } = input;
  if (!OPAQUE_ID.test(householdId) || !OPAQUE_ID.test(blobId) ||
    !Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0 ||
    plaintextBytes > MAX_MANAGED_VAULT_BYTES || !SHA256.test(expectedWireSha256) ||
    !Number.isSafeInteger(expectedWireBytes) || !Array.isArray(chunks))
    throw new CiphertextObjectIntegrityError();
  const count = Math.max(1, Math.ceil(plaintextBytes / MANAGED_VAULT_CHUNK_BYTES));
  if (chunks.length !== count) throw new CiphertextObjectIntegrityError();
  const header = Buffer.alloc(WIRE_HEADER_BYTES);
  header.write("ADEN", 0, "ascii");
  header[4] = MANAGED_VAULT_WIRE_VERSION;
  Buffer.from(blobId, "hex").copy(header, 5);
  header.writeUInt32BE(plaintextBytes, 21);
  header.writeUInt32BE(MANAGED_VAULT_CHUNK_BYTES, 25);
  header.writeUInt32BE(count, 29);
  const hash = createHash("sha256").update(header);
  const seenIvs = new Set<string>();
  const seenObjects = new Set<string>();
  let wireBytes = WIRE_HEADER_BYTES;
  for (const [index, chunk] of chunks.entries()) {
    if (signal?.aborted || !chunk || typeof chunk !== "object" ||
      chunk.index !== index ||
      !(chunk.iv instanceof Uint8Array) || chunk.iv.byteLength !== 12 ||
      typeof chunk.storageObjectId !== "string" ||
      !OPAQUE_ID.test(chunk.storageObjectId) ||
      typeof chunk.sha256 !== "string" || !SHA256.test(chunk.sha256) ||
      !Number.isSafeInteger(chunk.byteSize))
      throw new CiphertextObjectIntegrityError();
    const expectedBytes = Math.max(0, Math.min(MANAGED_VAULT_CHUNK_BYTES,
      plaintextBytes - index * MANAGED_VAULT_CHUNK_BYTES)) + GCM_TAG_BYTES;
    const iv = Buffer.from(chunk.iv);
    const ivHex = iv.toString("hex");
    if (chunk.byteSize !== expectedBytes || seenIvs.has(ivHex) ||
      seenObjects.has(chunk.storageObjectId))
      throw new CiphertextObjectIntegrityError();
    seenIvs.add(ivHex);
    seenObjects.add(chunk.storageObjectId);
    const ciphertext = await readCiphertextChunk(root, householdId,
      chunk.storageObjectId, chunk.sha256, chunk.byteSize);
    if (signal?.aborted) throw new CiphertextObjectIntegrityError();
    const chunkHeader = Buffer.alloc(CHUNK_HEADER_BYTES);
    iv.copy(chunkHeader, 0);
    chunkHeader.writeUInt32BE(ciphertext.byteLength, 12);
    hash.update(chunkHeader).update(ciphertext);
    wireBytes += CHUNK_HEADER_BYTES + ciphertext.byteLength;
  }
  const wireSha256 = hash.digest("hex");
  if (wireSha256 !== expectedWireSha256 || wireBytes !== expectedWireBytes)
    throw new CiphertextObjectIntegrityError();
  return { wireSha256, wireBytes, chunkCount: count };
}
