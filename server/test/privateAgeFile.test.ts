import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createPrivateBackupIdentity, decryptPrivateBackupFile, encryptPrivateBackupFile } from "../src/backup/privateAgeFile.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-age-backup-"));
  const identityPath = join(root, "off-host-identity");
  const { recipient } = await createPrivateBackupIdentity(identityPath);
  const sourcePath = join(root, "invented-source");
  const bytes = Buffer.alloc(200000, 17); bytes.write("INDEPENDENTLY INVENTED BACKUP MARKER");
  await writeFile(sourcePath, bytes, { mode: 0o600 });
  const encryptedPath = join(root, "encrypted.age");
  return { root, identityPath, recipient, sourcePath, encryptedPath, bytes };
}

it("encrypts multiple age chunks and restores exact bytes without exposing the identity", async () => {
  const state = await fixture();
  const receipt = await encryptPrivateBackupFile(state);
  const ciphertext = await readFile(state.encryptedPath);
  expect(receipt.sha256).toBe(createHash("sha256").update(ciphertext).digest("hex"));
  expect(ciphertext.includes(Buffer.from("INDEPENDENTLY INVENTED BACKUP MARKER"))).toBe(false);
  expect((await stat(state.identityPath)).mode & 0o777).toBe(0o600);
  const restoredPath = join(state.root, "restored");
  await decryptPrivateBackupFile({ ...state, restoredPath });
  expect(await readFile(restoredPath)).toEqual(state.bytes);
});

it("rejects a wrong identity, altered payload and truncated final chunk without publishing plaintext", async () => {
  const state = await fixture(); await encryptPrivateBackupFile(state);
  const otherIdentity = join(state.root, "other-identity"); await createPrivateBackupIdentity(otherIdentity);
  const destination = join(state.root, "must-not-publish");
  await expect(decryptPrivateBackupFile({ ...state, identityPath: otherIdentity, restoredPath: destination })).rejects.toThrow();
  const original = await readFile(state.encryptedPath);
  const tampered = Buffer.from(original); tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  for (const bytes of [tampered, original.subarray(0, original.length - 1)]) {
    await writeFile(state.encryptedPath, bytes);
    await expect(decryptPrivateBackupFile({ ...state, restoredPath: destination })).rejects.toThrow();
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("preserves existing output files and rejects broadly readable identities", async () => {
  const state = await fixture(); await encryptPrivateBackupFile(state);
  await expect(encryptPrivateBackupFile(state)).rejects.toThrow();
  const destination = join(state.root, "existing"); await writeFile(destination, "preserved", { mode: 0o600 });
  await expect(decryptPrivateBackupFile({ ...state, restoredPath: destination })).rejects.toThrow();
  expect(await readFile(destination, "utf8")).toBe("preserved");
  await chmod(state.identityPath, 0o644);
  await expect(decryptPrivateBackupFile({ ...state, restoredPath: join(state.root, "denied") })).rejects.toThrow();
});

it("rejects source symlinks and non-private parents before publishing a backup", async () => {
  const state = await fixture();
  const alias = join(state.root, "source-alias"); await symlink(state.sourcePath, alias);
  await expect(encryptPrivateBackupFile({ ...state, sourcePath: alias })).rejects.toThrow();
  await expect(stat(state.encryptedPath)).rejects.toMatchObject({ code: "ENOENT" });
  await chmod(state.root, 0o755);
  await expect(encryptPrivateBackupFile(state)).rejects.toThrow();
  await expect(createPrivateBackupIdentity(join(state.root, "denied-identity"))).rejects.toThrow();
});
