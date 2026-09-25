import { decryptVaultBlob, encryptVaultBlob, generateVaultKeyMaterial,
  importVaultKey, VAULT_CHUNK_BYTES } from "./vault";
import { decodeVaultBlob, encodeVaultBlob, VaultWireError } from "./vaultWire";

const scope = { householdId: "fictional-family-a", objectId: "opaque-object-a", revision: 1 };

async function key(): Promise<CryptoKey> {
  const material = generateVaultKeyMaterial();
  const result = await importVaultKey(material);
  material.fill(0);
  return result;
}

it("round-trips two encrypted chunks without carrying plaintext or a key", async () => {
  const vaultKey = await key();
  const marker = "FICTIONAL_HEALTH_MARKER_NOT_A_REAL_RECORD";
  const plaintext = new Uint8Array(VAULT_CHUNK_BYTES + marker.length);
  plaintext.set(new TextEncoder().encode(marker), VAULT_CHUNK_BYTES);
  const encrypted = await encryptVaultBlob(vaultKey, plaintext, scope);
  const wire = encodeVaultBlob(encrypted);
  expect(new TextDecoder().decode(wire)).not.toContain(marker);
  expect(wire.byteLength).toBe(33 + plaintext.byteLength + 2 * (12 + 4 + 16));
  await expect(decryptVaultBlob(vaultKey, decodeVaultBlob(wire), scope))
    .resolves.toEqual(plaintext);
});

it("round-trips an empty encrypted record", async () => {
  const vaultKey = await key();
  const wire = encodeVaultBlob(await encryptVaultBlob(vaultKey, new Uint8Array(0), scope));
  expect(decodeVaultBlob(wire).chunks).toHaveLength(1);
  await expect(decryptVaultBlob(vaultKey, decodeVaultBlob(wire), scope))
    .resolves.toEqual(new Uint8Array(0));
});

it("rejects malformed, truncated, excess, and contradictory wire bytes", async () => {
  const encrypted = await encryptVaultBlob(await key(), new Uint8Array([1, 2, 3]), scope);
  const wire = encodeVaultBlob(encrypted);
  const changed = (offset: number, value: number) => {
    const copy = wire.slice();
    copy[offset] = value;
    return copy;
  };
  for (const candidate of [
    changed(0, 0), changed(4, 2), changed(26, 0), changed(32, 2),
    changed(48, 0), wire.subarray(0, wire.byteLength - 1),
    new Uint8Array([...wire, 0]),
  ]) expect(() => decodeVaultBlob(candidate)).toThrow(VaultWireError);
  expect(() => encodeVaultBlob({ ...encrypted, chunks: [] })).toThrow(VaultWireError);
});

it("keeps cryptographic scope binding after wire conversion", async () => {
  const vaultKey = await key();
  const wire = encodeVaultBlob(await encryptVaultBlob(vaultKey,
    new TextEncoder().encode("fictional visit"), scope));
  await expect(decryptVaultBlob(vaultKey, decodeVaultBlob(wire), {
    ...scope, householdId: "fictional-family-b",
  })).rejects.toBeDefined();
});
