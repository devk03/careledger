import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, symlink,
  writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { encryptVaultBlob, generateVaultKeyMaterial,
  importVaultKey } from "../../web/src/crypto/vault.js";
import { CiphertextObjectIntegrityError, readCiphertextChunk,
  storeCiphertextChunk } from "../src/managed/ciphertextObjectStore.js";

const household = "fictional-family-a";
const marker = "FICTIONAL_CIPHERTEXT_MARKER_NOT_A_REAL_RECORD";

async function fixture() {
  const material = generateVaultKeyMaterial();
  const key = await importVaultKey(material);
  material.fill(0);
  const blob = await encryptVaultBlob(key, new TextEncoder().encode(marker),
    { householdId: household, objectId: "opaque-object-a", revision: 1 });
  return Buffer.from(blob.chunks[0]!.ciphertext);
}

async function roots() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-ciphertext-"));
  const hash = createHash("sha256").update(household).digest("hex");
  return { root, directory: join(root, hash.slice(0, 2), hash.slice(2, 4), hash) };
}

describe("private create-only ciphertext chunk storage", () => {
  it("persists only browser ciphertext and verifies an unchanged restart read", async () => {
    const { root, directory } = await roots();
    const ciphertext = await fixture();
    const stored = await storeCiphertextChunk(root, household, ciphertext);
    expect(stored.storageObjectId).toMatch(/^[0-9a-f]{32}$/);
    expect(stored.sha256).toBe(createHash("sha256").update(ciphertext).digest("hex"));
    expect(stored.byteSize).toBe(ciphertext.length);
    const path = join(directory, stored.storageObjectId);
    expect((await lstat(path)).mode & 0o777).toBe(0o400);
    const entries = await readdir(directory);
    const pending = entries.find((name) => name.startsWith("pending-"));
    expect(entries).toHaveLength(2);
    expect(pending).toBeDefined();
    expect((await lstat(join(directory, pending!))).ino).toBe((await lstat(path)).ino);
    const disk = await readFile(path);
    expect(disk).toEqual(ciphertext);
    expect(disk.includes(Buffer.from(marker))).toBe(false);
    expect(await readCiphertextChunk(root, household, stored.storageObjectId,
      stored.sha256, stored.byteSize)).toEqual(ciphertext);
    await expect(readCiphertextChunk(root, "fictional-family-b", stored.storageObjectId,
      stored.sha256, stored.byteSize)).rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
  });

  it("creates separate opaque objects and never content-deduplicates families", async () => {
    const { root } = await roots();
    const ciphertext = await fixture();
    const first = await storeCiphertextChunk(root, household, ciphertext);
    const second = await storeCiphertextChunk(root, household, ciphertext);
    const other = await storeCiphertextChunk(root, "fictional-family-b", ciphertext);
    expect(new Set([first.storageObjectId, second.storageObjectId,
      other.storageObjectId]).size).toBe(3);
    expect(first.sha256).toBe(second.sha256);
    expect(other.sha256).toBe(first.sha256);
  });

  it("fails closed for corrupted bytes, a symlink, and an unsafe storage root", async () => {
    const { root, directory } = await roots();
    const stored = await storeCiphertextChunk(root, household, await fixture());
    const path = join(directory, stored.storageObjectId);
    await chmod(path, 0o600);
    await expect(readCiphertextChunk(root, household, stored.storageObjectId,
      stored.sha256, stored.byteSize)).rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await writeFile(path, Buffer.alloc(stored.byteSize, 0));
    await expect(readCiphertextChunk(root, household, stored.storageObjectId,
      stored.sha256, stored.byteSize)).rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    const symlinkId = "f".repeat(32);
    await symlink(path, join(directory, symlinkId));
    await expect(readCiphertextChunk(root, household, symlinkId,
      stored.sha256, stored.byteSize)).rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await chmod(root, 0o755);
    await expect(storeCiphertextChunk(root, household, await fixture()))
      .rejects.toBeInstanceOf(Error);
  });

  it("rejects malformed scope, IDs, hashes, and non-chunk sizes", async () => {
    const { root } = await roots();
    await expect(storeCiphertextChunk(root, "bad/\nfamily", Buffer.alloc(16)))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await expect(storeCiphertextChunk(root, household, Buffer.alloc(15)))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await expect(storeCiphertextChunk(root, household, Buffer.alloc(1024 * 1024 + 17)))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await expect(readCiphertextChunk(root, household, "../fake", "0".repeat(64), 16))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    await expect(readCiphertextChunk(root, household, "0".repeat(32), "bad", 16))
      .rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
  });
});
