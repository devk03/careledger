import { createHash } from "node:crypto";
import { chmod, link, mkdtemp, readFile, readdir, symlink, writeFile } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditCiphertextObjectInventory, CiphertextObjectInventoryError } from
  "../src/managed/ciphertextObjectInventory.js";
import { storeCiphertextChunk } from
  "../src/managed/ciphertextObjectStore.js";

const householdId = "ab".repeat(16);
const bytes = Buffer.alloc(19, 0x92); // Synthetic ciphertext-shaped bytes only.

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-inventory-"));
  const committed = await storeCiphertextChunk(root, householdId, bytes);
  const hash = createHash("sha256").update(householdId).digest("hex");
  const directory = join(root, hash.slice(0, 2), hash.slice(2, 4), hash);
  const reference = { householdId, storageObjectId: committed.storageObjectId,
    sha256: committed.sha256, byteSize: committed.byteSize };
  return { root, directory, reference };
}

describe("offline ciphertext object inventory", () => {
  it("counts hard-linked pending aliases once and isolates unreferenced bytes", async () => {
    const test = await fixture();
    const extra = await storeCiphertextChunk(test.root, householdId,
      Buffer.alloc(23, 0x4b));
    const report = await auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference] });
    expect(report).toMatchObject({ committedObjectCount: 1, committedBytes: 19,
      missingCommitted: [], corruptCommitted: [], uniqueInodeContentBytes: 42,
      unreferencedInodeContentBytes: 23, orphanInodes: 1, orphanFinalNames: 1,
      orphanPendingNames: 1, committedPendingAliases: 1 });
    expect((await readdir(test.directory)).some((name) =>
      name === extra.storageObjectId)).toBe(true);
  });

  it("reports a partial pending-only file but does not modify it", async () => {
    const test = await fixture();
    const pending = join(test.directory,
      "pending-00000000-0000-4000-8000-000000000000");
    await writeFile(pending, Buffer.alloc(7, 0x31), { mode: 0o600 });
    const report = await auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference] });
    expect(report).toMatchObject({ uniqueInodeContentBytes: 26,
      unreferencedInodeContentBytes: 7,
      orphanInodes: 1, orphanFinalNames: 0, orphanPendingNames: 1 });
    expect(await readFile(pending)).toEqual(Buffer.alloc(7, 0x31));
  });

  it("separately reports missing and corrupted committed objects", async () => {
    const test = await fixture();
    const missing = { ...test.reference, storageObjectId: "ff".repeat(16) };
    const committedPath = join(test.directory, test.reference.storageObjectId);
    await chmod(committedPath, 0o600);
    await writeFile(committedPath, Buffer.alloc(bytes.length, 0x55));
    await chmod(committedPath, 0o400);
    const report = await auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference, missing] });
    expect(report.missingCommitted).toEqual([missing]);
    expect(report.corruptCommitted).toEqual([test.reference]);
    expect(report.unreferencedInodeContentBytes).toBe(0);
  });

  it("fails closed on unsafe aliases and duplicate references", async () => {
    const test = await fixture();
    await expect(auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference, test.reference] }))
      .rejects.toBeInstanceOf(CiphertextObjectInventoryError);
    await symlink(join(test.directory, test.reference.storageObjectId),
      join(test.directory, "ee".repeat(16)));
    await expect(auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference] }))
      .rejects.toBeInstanceOf(CiphertextObjectInventoryError);
  });

  it("rejects two final names for one inode instead of guessing ownership", async () => {
    const test = await fixture();
    await link(join(test.directory, test.reference.storageObjectId),
      join(test.directory, "dd".repeat(16)));
    await expect(auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference] }))
      .rejects.toBeInstanceOf(CiphertextObjectInventoryError);
  });

  it("rejects a hard link outside the audited root", async () => {
    const test = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "adeno-fictional-link-"));
    await link(join(test.directory, test.reference.storageObjectId),
      join(outside, "synthetic-ciphertext-alias"));
    await expect(auditCiphertextObjectInventory({ objectRoot: test.root,
      committedReferences: [test.reference] }))
      .rejects.toBeInstanceOf(CiphertextObjectInventoryError);
  });
});
