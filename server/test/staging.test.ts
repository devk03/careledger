import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inspectUploadBytes, UploadAdmissionError } from "../src/ingest/admission.js";
import { stageOriginalBytes, StagingIntegrityError, UnsafeStagingRoot } from "../src/ingest/staging.js";

const fictionalPdf = Buffer.from("%PDF-1.7\nSYNTHETIC TEST RECORD\n%%EOF", "utf8");

describe("private original-byte staging", () => {
  it("writes exact bytes once with a random non-identifying name and restrictive mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "adeno-fictional-stage-"));
    const admission = inspectUploadBytes(fictionalPdf, {
      originalName: "fictional-visit.pdf", receivedAt: new Date("2030-04-15T10:30:00Z"),
    });
    const first = await stageOriginalBytes(root, fictionalPdf, admission);
    const second = await stageOriginalBytes(root, fictionalPdf, admission);
    expect(first.path).not.toBe(second.path);
    expect(first.path).not.toContain("fictional-visit");
    expect(await readFile(first.path)).toEqual(fictionalPdf);
    expect(first.sha256).toBe(createHash("sha256").update(fictionalPdf).digest("hex"));
    expect(first.receivedAt).toBe("2030-04-15T10:30:00.000Z");
    expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
  });

  it("rejects forged metadata before creating a stage file", async () => {
    const root = await mkdtemp(join(tmpdir(), "adeno-fictional-forged-"));
    const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
    await expect(stageOriginalBytes(root, fictionalPdf, { ...admission, sha256: "0".repeat(64) }))
      .rejects.toBeInstanceOf(StagingIntegrityError);
    expect(await readdir(root)).toEqual([]);
  });

  it("does not stage unsupported bytes even if metadata has a matching digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "adeno-fictional-unsupported-"));
    const bytes = Buffer.from("SYNTHETIC UNSUPPORTED INPUT");
    const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
    await expect(stageOriginalBytes(root, bytes, {
      ...admission,
      byteSize: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })).rejects.toBeInstanceOf(UploadAdmissionError);
    expect(await readdir(root)).toEqual([]);
  });

  it("does not follow a symbolic-link staging root", async () => {
    const target = await mkdtemp(join(tmpdir(), "adeno-fictional-target-"));
    const container = await mkdtemp(join(tmpdir(), "adeno-fictional-link-"));
    const root = join(container, "staging-link");
    await symlink(target, root);
    const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
    await expect(stageOriginalBytes(root, fictionalPdf, admission))
      .rejects.toBeInstanceOf(UnsafeStagingRoot);
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects a staging root readable by other local users", async () => {
    const root = await mkdtemp(join(tmpdir(), "adeno-fictional-public-"));
    await chmod(root, 0o755);
    const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
    await expect(stageOriginalBytes(root, fictionalPdf, admission))
      .rejects.toBeInstanceOf(UnsafeStagingRoot);
    expect(await readdir(root)).toEqual([]);
  });

  it("requires an absolute staging root before making any filesystem change", async () => {
    const admission = inspectUploadBytes(fictionalPdf, { originalName: "fictional.pdf" });
    await expect(stageOriginalBytes("relative-staging-root", fictionalPdf, admission))
      .rejects.toBeInstanceOf(UnsafeStagingRoot);
  });
});
