import {
  VAULT_CHUNK_BYTES,
  VaultIntegrityError,
  decryptVaultBlob,
  encryptVaultBlob,
  generateVaultKeyMaterial,
  importVaultKey,
} from "./vault";

const scope = {
  householdId: "synthetic-household",
  objectId: "synthetic-object",
  revision: 1,
};

async function vaultKey(): Promise<CryptoKey> {
  const material = generateVaultKeyMaterial();
  const key = await importVaultKey(material);
  material.fill(0);
  return key;
}

it("encrypts every record chunk in the browser with a non-exportable key", async () => {
  const key = await vaultKey();
  const plaintext = new Uint8Array(VAULT_CHUNK_BYTES + 17);
  plaintext.fill(42);

  const encrypted = await encryptVaultBlob(key, plaintext, scope);
  expect(encrypted.chunks).toHaveLength(2);
  expect(encrypted.chunks[0].iv).not.toEqual(encrypted.chunks[1].iv);
  expect(encrypted.chunks[0].ciphertext.byteLength).toBe(VAULT_CHUNK_BYTES + 16);
  await expect(crypto.subtle.exportKey("raw", key)).rejects.toBeDefined();
  await expect(decryptVaultBlob(key, encrypted, scope)).resolves.toEqual(plaintext);
});

it("fails closed when ciphertext, ordering, or tenant scope is changed", async () => {
  const key = await vaultKey();
  const encrypted = await encryptVaultBlob(
    key,
    new TextEncoder().encode("SYNTHETIC TEST RECORD — NOT A REAL PATIENT"),
    scope,
  );
  const bytes = new Uint8Array(encrypted.chunks[0].ciphertext.slice(0));
  bytes[0] ^= 1;
  const tampered = {
    ...encrypted,
    chunks: [{ ...encrypted.chunks[0], ciphertext: bytes.buffer }],
  };

  await expect(decryptVaultBlob(key, tampered, scope)).rejects.toBeInstanceOf(
    VaultIntegrityError,
  );
  await expect(
    decryptVaultBlob(key, encrypted, { ...scope, householdId: "another-household" }),
  ).rejects.toBeInstanceOf(VaultIntegrityError);
});

it("detects reordered chunks and never returns a partial record", async () => {
  const key = await vaultKey();
  const plaintext = new Uint8Array(VAULT_CHUNK_BYTES + 1);
  const encrypted = await encryptVaultBlob(key, plaintext, scope);
  const reordered = { ...encrypted, chunks: [...encrypted.chunks].reverse() };

  await expect(decryptVaultBlob(key, reordered, scope)).rejects.toBeInstanceOf(
    VaultIntegrityError,
  );
});

it("uses a fresh IV for repeated encryption under one vault key", async () => {
  const key = await vaultKey();
  const plaintext = new Uint8Array([1, 2, 3]);
  const first = await encryptVaultBlob(key, plaintext, scope);
  const second = await encryptVaultBlob(key, plaintext, scope);

  expect(first.chunks[0].iv).not.toEqual(second.chunks[0].iv);
  expect(first.blobId).not.toEqual(second.blobId);
  expect(new Uint8Array(first.chunks[0].ciphertext)).not.toEqual(
    new Uint8Array(second.chunks[0].ciphertext),
  );
});

it("rejects chunks spliced from separate valid encryptions", async () => {
  const key = await vaultKey();
  const plaintext = new Uint8Array(VAULT_CHUNK_BYTES + 1);
  const first = await encryptVaultBlob(key, plaintext, scope);
  const second = await encryptVaultBlob(key, plaintext, scope);
  const spliced = { ...first, chunks: [first.chunks[0], second.chunks[1]] };

  await expect(decryptVaultBlob(key, spliced, scope)).rejects.toBeInstanceOf(
    VaultIntegrityError,
  );
});

it("rejects non-256-bit keys and oversized ciphertext before decryption", async () => {
  const weakKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt", "decrypt"],
  );
  await expect(
    encryptVaultBlob(weakKey, new Uint8Array([1]), scope),
  ).rejects.toThrow("non-exportable AES-GCM");

  const key = await vaultKey();
  const encrypted = await encryptVaultBlob(key, new Uint8Array([1]), scope);
  const oversized = {
    ...encrypted,
    chunks: [{ ...encrypted.chunks[0], ciphertext: new ArrayBuffer(18) }],
  };
  await expect(decryptVaultBlob(key, oversized, scope)).rejects.toBeInstanceOf(
    VaultIntegrityError,
  );
});
