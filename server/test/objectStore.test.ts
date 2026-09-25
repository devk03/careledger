import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectUploadBytes } from "../src/ingest/admission.js";
import { commitStagedObject, ObjectIntegrityError } from "../src/ingest/objectStore.js";
import { provisionPrivateDirectory } from "../src/ingest/privateDirectory.js";
import { stageOriginalBytes } from "../src/ingest/staging.js";

const fictionalPdf = Buffer.from("%PDF-1.7\nFICTIONAL INTAKE TEST ONLY\n%%EOF", "utf8");

async function roots() {
  const parent = await mkdtemp(join(tmpdir(), "adeno-fictional-store-"));
  return {
    quarantine: await provisionPrivateDirectory(parent, "quarantine"),
    objects: await provisionPrivateDirectory(parent, "objects"),
  };
}

async function stage(quarantine: string) {
  const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
  return stageOriginalBytes(quarantine, fictionalPdf, admission);
}

describe("private immutable object-store primitive", () => {
  it("atomically names verified bytes by digest and deduplicates without replacement", async () => {
    const { quarantine, objects } = await roots();
    const firstStage = await stage(quarantine);
    const first = await commitStagedObject(objects, quarantine, firstStage);
    const expected = createHash("sha256").update(fictionalPdf).digest("hex");
    expect(first.sha256).toBe(expected);
    expect(first.path).toBe(join(objects, expected.slice(0, 2), expected.slice(2, 4), expected));
    expect(first.alreadyExisted).toBe(false);
    expect(await readFile(first.path)).toEqual(fictionalPdf);
    expect((await lstat(first.path)).mode & 0o777).toBe(0o400);
    // A crash between link and chmod can leave a private but writable inode;
    // a verified duplicate retry must complete the read-only transition.
    await chmod(first.path, 0o600);
    const second = await commitStagedObject(objects, quarantine, await stage(quarantine));
    expect(second.path).toBe(first.path);
    expect(second.alreadyExisted).toBe(true);
    expect(await readFile(first.path)).toEqual(fictionalPdf);
    expect((await lstat(first.path)).mode & 0o777).toBe(0o400);
  });

  it("rejects a corrupted existing digest path without overwriting it", async () => {
    const { quarantine, objects } = await roots();
    const staged = await stage(quarantine);
    const first = await provisionPrivateDirectory(objects, staged.sha256.slice(0, 2));
    const second = await provisionPrivateDirectory(first, staged.sha256.slice(2, 4));
    const destination = join(second, staged.sha256);
    await writeFile(destination, Buffer.alloc(fictionalPdf.length, 0), { flag: "wx", mode: 0o600 });
    await expect(commitStagedObject(objects, quarantine, staged))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(await readFile(destination)).toEqual(Buffer.alloc(fictionalPdf.length, 0));
  });

  it("ignores incomplete pending files from a prior crash and retries safely", async () => {
    const { quarantine, objects } = await roots();
    const staged = await stage(quarantine);
    const first = await provisionPrivateDirectory(objects, staged.sha256.slice(0, 2));
    const second = await provisionPrivateDirectory(first, staged.sha256.slice(2, 4));
    const orphan = join(second, "pending-00000000-0000-0000-0000-000000000000");
    await writeFile(orphan, "incomplete fictional copy", { flag: "wx", mode: 0o600 });
    const stored = await commitStagedObject(objects, quarantine, staged);
    expect(stored.alreadyExisted).toBe(false);
    expect(await readFile(stored.path)).toEqual(fictionalPdf);
    expect(await readFile(orphan, "utf8")).toBe("incomplete fictional copy");
  });

  it("handles concurrent identical uploads without overwriting the digest path", async () => {
    const { quarantine, objects } = await roots();
    const stages = await Promise.all([stage(quarantine), stage(quarantine)]);
    const results = await Promise.all(stages.map((staged) =>
      commitStagedObject(objects, quarantine, staged)));
    expect(results[0]?.path).toBe(results[1]?.path);
    expect(results.filter((result) => !result.alreadyExisted)).toHaveLength(1);
    expect(await readFile(results[0]!.path)).toEqual(fictionalPdf);
  });

  it("rejects a mutated or forged quarantine payload before publication", async () => {
    const { quarantine, objects } = await roots();
    const staged = await stage(quarantine);
    await writeFile(staged.path, Buffer.alloc(fictionalPdf.length, 1));
    await expect(commitStagedObject(objects, quarantine, staged))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(await readdir(objects)).toEqual([]);
    const another = await stage(quarantine);
    await expect(commitStagedObject(objects, quarantine, { ...another, path: staged.path }))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    expect(await readdir(objects)).toEqual([]);
  });

  it("does not share an inode with a quarantine writer held open before promotion", async () => {
    const { quarantine, objects } = await roots();
    const staged = await stage(quarantine);
    const heldWriter = await open(staged.path, "r+");
    try {
      const stored = await commitStagedObject(objects, quarantine, staged);
      expect((await lstat(staged.path)).ino).not.toBe((await lstat(stored.path)).ino);
      await heldWriter.write(Buffer.from("X"), 0, 1, 0);
      await heldWriter.sync();
      expect(await readFile(stored.path)).toEqual(fictionalPdf);
      expect((await readFile(staged.path))[0]).toBe("X".charCodeAt(0));
    } finally {
      await heldWriter.close();
    }
  });

  it("rejects unsafe roots and a symlink at the staged-file path", async () => {
    const { quarantine, objects } = await roots();
    const staged = await stage(quarantine);
    await chmod(objects, 0o755);
    await expect(commitStagedObject(objects, quarantine, staged))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    await chmod(objects, 0o700);
    const linked = await stage(quarantine);
    const outside = await mkdtemp(join(tmpdir(), "adeno-fictional-outside-"));
    const fake = join(outside, "fake.pdf");
    await writeFile(fake, fictionalPdf);
    const stagePath = join(quarantine, `incoming-${linked.stageId}`);
    // A distinct staged ID cannot be redirected by changing its path field.
    await expect(commitStagedObject(objects, quarantine,
      { ...linked, path: join(quarantine, "different") }))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    const symlinkPath = join(quarantine, "incoming-00000000-0000-0000-0000-000000000000");
    await symlink(fake, symlinkPath);
    await expect(commitStagedObject(objects, quarantine, { ...linked,
      stageId: "00000000-0000-0000-0000-000000000000", path: symlinkPath }))
      .rejects.toBeInstanceOf(ObjectIntegrityError);
    expect((await lstat(stagePath)).isFile()).toBe(true);
  });
});
