import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "age-encryption";

const MAX_BYTES = 1024 * 1024 * 1024;
export class PrivateBackupFileError extends Error {
  constructor() { super("Private backup file is unavailable or invalid"); }
}
async function privateParent(path: string) {
  if (!isAbsolute(path)) throw new PrivateBackupFileError();
  const info = await lstat(dirname(path));
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.())
    throw new PrivateBackupFileError();
}
async function privateInput(path: string, maxBytes: number) {
  await privateParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size < 1 || info.size > maxBytes)
      throw new PrivateBackupFileError();
    return { file, info };
  } catch { await file.close(); throw new PrivateBackupFileError(); }
}
async function syncParent(path: string) {
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Run on the off-host owner's device. Never returns or logs the private identity. */
export async function createPrivateBackupIdentity(path: string): Promise<{ recipient: string }> {
  try {
    await privateParent(path);
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${identity}\n`); await file.sync(); } finally { await file.close(); }
    await syncParent(path); return { recipient };
  } catch { throw new PrivateBackupFileError(); }
}

async function publishStream(path: string, source: ReadableStream<Uint8Array>, maxBytes: number,
  beforePublish?: () => Promise<void>) {
  await privateParent(path);
  // Partial decrypted data remains private and unreferenced until authentication finishes.
  const pending = join(dirname(path), `pending-backup-${randomUUID()}`);
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    const reader = source.getReader();
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) throw new PrivateBackupFileError();
        digest.update(chunk.value); await file.writeFile(chunk.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    await file.sync();
  } finally { await file.close(); }
  await beforePublish?.();
  await link(pending, path); // No overwrite, even during a competing publication.
  await syncParent(path);
  return { sha256: digest.digest("hex"), bytes };
}

export async function encryptPrivateBackupFile(input: { sourcePath: string; encryptedPath: string; recipient: string }) {
  let source: Awaited<ReturnType<typeof privateInput>> | undefined;
  try {
    source = await privateInput(input.sourcePath, MAX_BYTES);
    const encrypter = new Encrypter(); encrypter.addRecipient(input.recipient);
    const stream = Readable.toWeb(source.file.createReadStream({ autoClose: false })) as ReadableStream<Uint8Array>;
    const encrypted = await encrypter.encrypt(stream);
    return await publishStream(input.encryptedPath, encrypted, MAX_BYTES + 1024 * 1024, async () => {
      const after = await source!.file.stat();
      if (after.size !== source!.info.size || after.mtimeMs !== source!.info.mtimeMs ||
        after.ctimeMs !== source!.info.ctimeMs) throw new PrivateBackupFileError();
    });
  } catch { throw new PrivateBackupFileError(); }
  finally { await source?.file.close(); }
}

/** Publishes only after the entire age stream authenticates; archive validation is a separate gate. */
export async function decryptPrivateBackupFile(input: { encryptedPath: string; restoredPath: string; identityPath: string }) {
  let source: Awaited<ReturnType<typeof privateInput>> | undefined;
  let identity: Awaited<ReturnType<typeof privateInput>> | undefined;
  try {
    source = await privateInput(input.encryptedPath, MAX_BYTES + 1024 * 1024);
    identity = await privateInput(input.identityPath, 1024);
    const decrypter = new Decrypter(); decrypter.addIdentity((await identity.file.readFile("utf8")).trim());
    const stream = Readable.toWeb(source.file.createReadStream({ autoClose: false })) as ReadableStream<Uint8Array>;
    const decrypted = await decrypter.decrypt(stream);
    return await publishStream(input.restoredPath, decrypted, MAX_BYTES, async () => {
      const after = await source!.file.stat();
      if (after.size !== source!.info.size || after.mtimeMs !== source!.info.mtimeMs ||
        after.ctimeMs !== source!.info.ctimeMs) throw new PrivateBackupFileError();
    });
  } catch { throw new PrivateBackupFileError(); }
  finally { await source?.file.close(); await identity?.file.close(); }
}
