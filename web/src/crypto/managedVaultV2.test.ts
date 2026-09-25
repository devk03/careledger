import { decodeManagedVaultBlobV2, encodeManagedVaultBlobV2,
  ManagedVaultWireV2Error, MANAGED_VAULT_CHUNK_BYTES,
  type ManagedVaultBlobV2 } from "@adeno/contracts";

import { encryptVaultBlob, generateVaultKeyMaterial, importVaultKey } from "./vault";
import { decodeVaultBlob, encodeVaultBlob } from "./vaultWire";
import { decryptManagedVaultBlobV2, encryptManagedVaultBlobV2,
  ManagedVaultIntegrityV2Error, type ManagedVaultScopeV2 } from "./managedVaultV2";

const scope: ManagedVaultScopeV2 = {
  householdId: "11".repeat(16), careProfileId: "22".repeat(16),
  opaqueScopeId: "33".repeat(16), objectId: "44".repeat(16),
  keyEpoch: 1, purpose: "day-snapshot", revision: 1,
};
const marker = "FICTIONAL_V2_MARKER_NOT_A_REAL_RECORD";

async function key(): Promise<CryptoKey> {
  const material = generateVaultKeyMaterial();
  try { return await importVaultKey(material); }
  finally { material.fill(0); }
}

async function encrypted() {
  const dayKey = await key();
  const plaintext = new TextEncoder().encode(marker);
  return { dayKey, plaintext,
    blob: await encryptManagedVaultBlobV2(dayKey, plaintext, scope) };
}

it("round-trips browser ciphertext with no clinical scope in the v2 wire", async () => {
  const { dayKey, blob } = await encrypted();
  const wire = encodeManagedVaultBlobV2(blob);
  expect(wire[4]).toBe(2);
  expect(new TextDecoder().decode(wire)).not.toContain(marker);
  expect(new TextDecoder().decode(wire)).not.toContain(scope.householdId);
  expect(dayKey.extractable).toBe(false);
  expect(new TextDecoder().decode(await decryptManagedVaultBlobV2(dayKey,
    decodeManagedVaultBlobV2(wire), scope))).toBe(marker);
});

it("never silently treats old household-wide v1 blobs as per-day v2 blobs", async () => {
  const dayKey = await key();
  const old = await encryptVaultBlob(dayKey, new Uint8Array([1]),
    { householdId: "fictional-family", objectId: "fictional-object", revision: 1 });
  const newBlob = await encryptManagedVaultBlobV2(dayKey, new Uint8Array([2]), scope);
  expect(() => decodeManagedVaultBlobV2(encodeVaultBlob(old)))
    .toThrow(ManagedVaultWireV2Error);
  expect(() => decodeVaultBlob(encodeManagedVaultBlobV2(newBlob))).toThrow();
});

it.each([
  { householdId: "aa".repeat(16) }, { careProfileId: "aa".repeat(16) },
  { opaqueScopeId: "aa".repeat(16) }, { objectId: "aa".repeat(16) },
  { keyEpoch: 2 }, { purpose: "source-original" as const },
  { purpose: "encrypted-index" as const }, { revision: 2 },
])("rejects ciphertext under a different authenticated scope: %o", async (change) => {
  const { dayKey, blob } = await encrypted();
  await expect(decryptManagedVaultBlobV2(dayKey, blob, { ...scope, ...change }))
    .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
});

it("keeps an encrypted index in a purpose-separated v2 key domain", async () => {
  const indexKey = await key();
  const indexScope = { ...scope, purpose: "encrypted-index" as const };
  const index = new TextEncoder().encode("FICTIONAL_LOCAL_INDEX_NOT_A_REAL_RECORD");
  const blob = await encryptManagedVaultBlobV2(indexKey, index, indexScope);
  expect(new TextDecoder().decode(await decryptManagedVaultBlobV2(indexKey,
    blob, indexScope))).toBe("FICTIONAL_LOCAL_INDEX_NOT_A_REAL_RECORD");
  await expect(decryptManagedVaultBlobV2(indexKey, blob, scope))
    .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
});

it("rejects a different day key even when all opaque scope fields match", async () => {
  const { blob } = await encrypted();
  await expect(decryptManagedVaultBlobV2(await key(), blob, scope))
    .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
});

it("rejects changed IV, ciphertext, tag and blob ID without returning partial bytes", async () => {
  const { dayKey, blob } = await encrypted();
  const wire = encodeManagedVaultBlobV2(blob);
  for (const offset of [5, 33, 49, wire.byteLength - 1]) {
    const changed = wire.slice();
    changed[offset]! ^= 1;
    await expect(decryptManagedVaultBlobV2(dayKey,
      decodeManagedVaultBlobV2(changed), scope))
      .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
  }
});

it("authenticates chunk position across a multi-chunk record", async () => {
  const dayKey = await key();
  const input = new Uint8Array(MANAGED_VAULT_CHUNK_BYTES + 1);
  input.fill(42);
  const blob = await encryptManagedVaultBlobV2(dayKey, input, scope);
  expect(blob.chunks).toHaveLength(2);
  expect(blob.chunks[0]!.iv).not.toEqual(blob.chunks[1]!.iv);
  const reordered: ManagedVaultBlobV2 = { ...blob, chunks: [...blob.chunks].reverse() };
  await expect(decryptManagedVaultBlobV2(dayKey, reordered, scope))
    .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
  const reusedIv: ManagedVaultBlobV2 = { ...blob, chunks: [blob.chunks[0]!,
    { ...blob.chunks[1]!, iv: blob.chunks[0]!.iv.slice() }] };
  expect(() => encodeManagedVaultBlobV2(reusedIv)).toThrow(ManagedVaultWireV2Error);
  expect(await decryptManagedVaultBlobV2(dayKey, blob, scope)).toEqual(input);
});

it("cannot return a partial record if the caller mutates chunks during decryption", async () => {
  const dayKey = await key();
  const input = new Uint8Array(MANAGED_VAULT_CHUNK_BYTES + 1);
  input.fill(42);
  input[input.length - 1] = 7;
  const blob = await encryptManagedVaultBlobV2(dayKey, input, scope);
  const pending = decryptManagedVaultBlobV2(dayKey, blob, scope);
  blob.chunks.splice(1);
  blob.blobId.fill(0);
  blob.chunks[0]!.iv.fill(0);
  const result = await pending;
  expect(result).toEqual(input);
  expect(result[result.length - 1]).toBe(7);
});

it("rejects malformed framing and copies every decoded byte field", async () => {
  const { blob } = await encrypted();
  const wire = encodeManagedVaultBlobV2(blob);
  for (const changed of [wire.subarray(0, -1), Uint8Array.from([...wire, 0]),
    Uint8Array.from(wire)]) {
    if (changed.byteLength === wire.byteLength) changed[4] = 3;
    expect(() => decodeManagedVaultBlobV2(changed)).toThrow(ManagedVaultWireV2Error);
  }
  const parsed = decodeManagedVaultBlobV2(wire);
  const first = parsed.chunks[0]!;
  const iv = first.iv[0];
  const ciphertext = new Uint8Array(first.ciphertext)[0];
  wire.fill(0);
  expect(first.iv[0]).toBe(iv);
  expect(new Uint8Array(first.ciphertext)[0]).toBe(ciphertext);
});

it("rejects hidden scope fields, non-opaque IDs and invalid epochs", async () => {
  const dayKey = await key();
  const input = new Uint8Array([1]);
  for (const invalid of [
    { ...scope, careDate: "2026-01-01" },
    { ...scope, careProfileId: "a real name" },
    { ...scope, keyEpoch: 0 },
  ]) {
    await expect(encryptManagedVaultBlobV2(dayKey, input, invalid))
      .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
  }
});
