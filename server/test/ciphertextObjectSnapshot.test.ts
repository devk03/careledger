import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readCiphertextChunk, storeCiphertextChunk } from
  "../src/managed/ciphertextObjectStore.js";
import { CiphertextSnapshotError, createCiphertextObjectSnapshot,
  restoreCiphertextObjectSnapshot, verifyCiphertextObjectSnapshot,
  type CiphertextObjectReference } from
  "../src/managed/ciphertextObjectSnapshot.js";

const householdId = "11".repeat(16);
const snapshotId = "22".repeat(16);

async function fixture() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-source-"));
  const backupRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-backup-"));
  const firstBytes = Buffer.alloc(19, 0x61);
  const secondBytes = Buffer.alloc(19, 0x62);
  const first = await storeCiphertextChunk(sourceRoot, householdId, firstBytes);
  const second = await storeCiphertextChunk(sourceRoot, householdId, secondBytes);
  const reference: CiphertextObjectReference = { householdId,
    storageObjectId: first.storageObjectId, sha256: first.sha256,
    byteSize: first.byteSize };
  return { sourceRoot, backupRoot, firstBytes, first, second, reference };
}

describe("ciphertext-only object snapshot", () => {
  it("copies only committed references, never pending aliases or other objects", async () => {
    const test = await fixture();
    const proof = await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    expect(proof).toEqual({ manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      objectCount: 1, totalBytes: test.firstBytes.length });
    const names = await readdir(join(test.backupRoot, snapshotId));
    expect(names.sort()).toEqual([
      `${householdId}-${test.first.storageObjectId}`, "manifest.json"].sort());
    expect(names.join(" ")).not.toContain(test.second.storageObjectId);
    expect(names.some((name) => name.startsWith("pending-"))).toBe(false);
    expect((await lstat(join(test.backupRoot, snapshotId, "manifest.json"))).mode & 0o777)
      .toBe(0o400);
    expect(await verifyCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: proof.manifestSha256 })).toEqual(proof);
  });

  it("rejects changed backup bytes or an unpinned manifest", async () => {
    const test = await fixture();
    const proof = await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    await expect(verifyCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: createHash("sha256")
        .update("wrong fictional manifest").digest("hex") }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
    const copied = join(test.backupRoot, snapshotId,
      `${householdId}-${test.first.storageObjectId}`);
    await chmod(copied, 0o600);
    await writeFile(copied, Buffer.alloc(test.first.byteSize, 0));
    await chmod(copied, 0o400);
    await expect(verifyCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: proof.manifestSha256 }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
  });

  it("fails before publication on duplicate or sparse references and refuses overwrite", async () => {
    const test = await fixture();
    await expect(createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId,
      references: [test.reference, test.reference] }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
    const sparse = new Array<CiphertextObjectReference>(1);
    await expect(createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: sparse }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
    await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    await expect(createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
  });

  it("leaves an interrupted copy unpublished and retries under a fresh ID", async () => {
    const test = await fixture();
    const missing: CiphertextObjectReference = { householdId,
      storageObjectId: "ff".repeat(16), sha256: "00".repeat(32), byteSize: 19 };
    await expect(createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId,
      references: [test.reference, missing] })).rejects.toBeInstanceOf(
      CiphertextSnapshotError);
    await expect(lstat(join(test.backupRoot, snapshotId))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await readdir(test.backupRoot)).some((name) => name.startsWith("pending-")))
      .toBe(true);
    const retryId = "23".repeat(16);
    const proof = await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId: retryId, references: [test.reference] });
    expect((await verifyCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId: retryId, expectedManifestSha256: proof.manifestSha256 })).objectCount).toBe(1);
  });

  it("rejects extra files beside the pinned manifest", async () => {
    const test = await fixture();
    const proof = await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    await writeFile(join(test.backupRoot, snapshotId, "unlisted-object"),
      Buffer.from("fictional extra"), { mode: 0o600 });
    await expect(verifyCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: proof.manifestSha256 }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
  });

  it("allows exactly one concurrent creator for a snapshot ID", async () => {
    const test = await fixture();
    const request = () => createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    const results = await Promise.allSettled([request(), request()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const success = results.find((result) => result.status === "fulfilled");
    if (!success || success.status !== "fulfilled") throw new Error("fictional snapshot missing");
    expect(await verifyCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: success.value.manifestSha256 }))
      .toEqual(success.value);
  });

  it("restores pinned ciphertext IDs into a new private object root only", async () => {
    const test = await fixture();
    const proof = await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    const targetParent = await mkdtemp(join(tmpdir(), "adeno-fictional-restore-"));
    const restored = await restoreCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: proof.manifestSha256, targetParent });
    expect(restored).toEqual({ ...proof,
      targetRoot: expect.stringContaining(`restored-${snapshotId}-`) });
    expect(await readCiphertextChunk(restored.targetRoot, householdId,
      test.first.storageObjectId, test.first.sha256, test.first.byteSize))
      .toEqual(test.firstBytes);
    await expect(readCiphertextChunk(restored.targetRoot, householdId,
      test.second.storageObjectId, test.second.sha256, test.second.byteSize))
      .rejects.toThrow();
    expect((await lstat(join(restored.targetRoot, ".restore-complete"))).mode & 0o777)
      .toBe(0o400);
    expect((await lstat(join(restored.targetRoot, ".restore-complete"))).ino)
      .toBe((await lstat(join(restored.targetRoot, ".restore-marker-pending"))).ino);
    expect(JSON.parse((await readFile(join(restored.targetRoot, ".restore-complete")))
      .toString("utf8"))).toEqual({ format: "adeno.object-restore.v1",
      snapshotId, manifestSha256: proof.manifestSha256 });
    await expect(restoreCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: proof.manifestSha256,
      targetParent: test.backupRoot }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
  });

  it("does not start restoration from a damaged or unpinned snapshot", async () => {
    const test = await fixture();
    const proof = await createCiphertextObjectSnapshot({ sourceRoot: test.sourceRoot,
      backupRoot: test.backupRoot, snapshotId, references: [test.reference] });
    const targetParent = await mkdtemp(join(tmpdir(), "adeno-fictional-restore-"));
    const copied = join(test.backupRoot, snapshotId,
      `${householdId}-${test.first.storageObjectId}`);
    await chmod(copied, 0o600);
    await writeFile(copied, Buffer.alloc(test.first.byteSize, 0));
    await chmod(copied, 0o400);
    await expect(restoreCiphertextObjectSnapshot({ backupRoot: test.backupRoot,
      snapshotId, expectedManifestSha256: proof.manifestSha256, targetParent }))
      .rejects.toBeInstanceOf(CiphertextSnapshotError);
    expect(await readdir(targetParent)).toEqual([]);
  });
});
