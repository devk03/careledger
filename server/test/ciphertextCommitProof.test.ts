import { createHash } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeManagedVaultBlobV2, MANAGED_VAULT_CHUNK_BYTES,
  MANAGED_VAULT_FORMAT_V2 } from "@adeno/contracts";
import { describe, expect, it } from "vitest";

import { CiphertextObjectIntegrityError, storeCiphertextChunk } from
  "../src/managed/ciphertextObjectStore.js";
import { proveStoredCiphertextWire, type StagedCiphertextChunk } from
  "../src/managed/ciphertextCommitProof.js";

const householdId = "11".repeat(16);
const blobId = "22".repeat(16);

async function fictionalStaging(plaintextBytes: number) {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-proof-"));
  const count = Math.max(1, Math.ceil(plaintextBytes / MANAGED_VAULT_CHUNK_BYTES));
  const chunks: StagedCiphertextChunk[] = [];
  const wireChunks: { iv: Uint8Array; ciphertext: ArrayBuffer }[] = [];
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = Math.max(0, Math.min(MANAGED_VAULT_CHUNK_BYTES,
      plaintextBytes - index * MANAGED_VAULT_CHUNK_BYTES)) + 16;
    const iv = new Uint8Array(12).fill(index + 1);
    const ciphertext = new Uint8Array(size).fill(0xa0 + index);
    const stored = await storeCiphertextChunk(root, householdId, ciphertext);
    chunks.push({ index, iv, storageObjectId: stored.storageObjectId,
      sha256: stored.sha256, byteSize: stored.byteSize });
    wireChunks.push({ iv, ciphertext: ciphertext.buffer });
    const digest = createHash("sha256").update(householdId).digest("hex");
    paths.push(join(root, digest.slice(0, 2), digest.slice(2, 4), digest,
      stored.storageObjectId));
  }
  const wire = Buffer.from(encodeManagedVaultBlobV2({ format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(blobId, "hex"), plaintextSize: plaintextBytes,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES, chunks: wireChunks }));
  const expectedWireSha256 = createHash("sha256").update(wire).digest("hex");
  return { root, paths, wire, chunks, input: { root, householdId, blobId,
    plaintextBytes, expectedWireSha256, expectedWireBytes: wire.length, chunks } };
}

describe("ciphertext commit proof", () => {
  it("matches the full v2 wire from independently stored fictional chunks", async () => {
    const staging = await fictionalStaging(MANAGED_VAULT_CHUNK_BYTES + 1);
    const proof = await proveStoredCiphertextWire(staging.input);
    expect(proof).toEqual({ wireSha256: staging.input.expectedWireSha256,
      wireBytes: staging.wire.length, chunkCount: 2 });
  });

  it("rejects corrupted objects and metadata that no longer matches intake", async () => {
    const staging = await fictionalStaging(3);
    const changedIv = staging.chunks.map((chunk) => ({ ...chunk,
      iv: new Uint8Array(12).fill(7) }));
    await expect(proveStoredCiphertextWire({ ...staging.input, chunks: changedIv }))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await chmod(staging.paths[0]!, 0o600);
    await writeFile(staging.paths[0]!, Buffer.alloc(19, 0));
    await chmod(staging.paths[0]!, 0o400);
    await expect(proveStoredCiphertextWire(staging.input))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
  });

  it("requires exact chunk order, object identity, size, and a live signal", async () => {
    const staging = await fictionalStaging(MANAGED_VAULT_CHUNK_BYTES + 1);
    const reversed = [...staging.chunks].reverse();
    await expect(proveStoredCiphertextWire({ ...staging.input, chunks: reversed }))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    const repeated = [staging.chunks[0]!, { ...staging.chunks[1]!,
      storageObjectId: staging.chunks[0]!.storageObjectId }];
    await expect(proveStoredCiphertextWire({ ...staging.input, chunks: repeated }))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await expect(proveStoredCiphertextWire({ ...staging.input,
      expectedWireBytes: staging.input.expectedWireBytes - 1 }))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await expect(proveStoredCiphertextWire({ ...staging.input,
      plaintextBytes: staging.input.plaintextBytes - 1 }))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(proveStoredCiphertextWire({ ...staging.input,
      signal: aborted.signal })).rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
  });

  it("fails closed on a sparse chunk list instead of throwing a raw type error", async () => {
    const staging = await fictionalStaging(0);
    const sparse = new Array<StagedCiphertextChunk>(1);
    await expect(proveStoredCiphertextWire({ ...staging.input, chunks: sparse }))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
  });
});
