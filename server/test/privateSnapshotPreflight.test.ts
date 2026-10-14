import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createPrivateSnapshot, restorePrivateSnapshot } from "../src/backup/privateSnapshot.js";

// No SQLite file is opened and no schema is created by these preflight tests.
it("denies restore before creating working directories when the off-host pin or input permissions fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-snapshot-preflight-"));
  const encryptedPath = join(root, "invented-ciphertext");
  const bytes = Buffer.from("INVENTED NON-AGE BYTES");
  await writeFile(encryptedPath, bytes, { mode: 0o600 });
  const workRoot = join(root, "work");
  const input = { encryptedPath, identityPath: join(root, "absent-identity"), workRoot,
    destinationRoot: join(root, "destination"), expectedSha256: "0".repeat(64) };
  await expect(restorePrivateSnapshot(input)).rejects.toThrow();
  await expect(stat(workRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await chmod(encryptedPath, 0o644);
  await expect(restorePrivateSnapshot({ ...input, expectedSha256: createHash("sha256").update(bytes).digest("hex") })).rejects.toThrow();
  await expect(stat(workRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(encryptedPath)).toEqual(bytes);
});

it("denies overlapping snapshot output without touching the live storage directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-snapshot-overlap-"));
  const objectRoot = join(root, "objects"); await mkdir(objectRoot, { mode: 0o700 });
  const snapshotRoot = join(root, "snapshot");
  await expect(createPrivateSnapshot({ sourceDbPath: join(root, "case.sqlite"), objectRoot,
    recoveryPepperPath: join(root, "pepper"), snapshotRoot, encryptedPath: join(root, "backup.age"),
    recipient: "invalid", writersStopped: true })).rejects.toThrow();
  await expect(stat(snapshotRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(objectRoot)).isDirectory()).toBe(true);
});
