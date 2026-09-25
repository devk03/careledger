import { chmod, lstat, mkdtemp, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { provisionPrivateDirectory, UnsafeStorageDirectory } from "../src/ingest/privateDirectory.js";

describe("durable private intake directory provisioning", () => {
  it("creates one private child and can verify it again without replacing it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "adeno-fictional-provision-"));
    const first = await provisionPrivateDirectory(parent, "quarantine");
    const second = await provisionPrivateDirectory(parent, "quarantine");
    expect(second).toBe(first);
    expect((await lstat(first)).mode & 0o777).toBe(0o700);
    expect(await readdir(parent)).toEqual(["quarantine"]);
  });

  it("rejects a public parent before making a child", async () => {
    const parent = await mkdtemp(join(tmpdir(), "adeno-fictional-public-parent-"));
    await chmod(parent, 0o755);
    await expect(provisionPrivateDirectory(parent, "quarantine"))
      .rejects.toBeInstanceOf(UnsafeStorageDirectory);
    expect(await readdir(parent)).toEqual([]);
  });

  it("rejects traversal, a symlinked parent, and a symlinked child", async () => {
    const parent = await mkdtemp(join(tmpdir(), "adeno-fictional-private-parent-"));
    await expect(provisionPrivateDirectory(parent, "../elsewhere"))
      .rejects.toBeInstanceOf(UnsafeStorageDirectory);
    const containing = await mkdtemp(join(tmpdir(), "adeno-fictional-link-container-"));
    const linkedParent = join(containing, "linked-parent");
    await symlink(parent, linkedParent);
    await expect(provisionPrivateDirectory(linkedParent, "quarantine"))
      .rejects.toBeInstanceOf(UnsafeStorageDirectory);
    const target = await mkdtemp(join(tmpdir(), "adeno-fictional-target-"));
    await symlink(target, join(parent, "quarantine"));
    await expect(provisionPrivateDirectory(parent, "quarantine"))
      .rejects.toBeInstanceOf(UnsafeStorageDirectory);
  });
});
