import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { provisionPrivateDirectory } from "../ingest/privateDirectory.js";

const MAX_CIPHERTEXT_CHUNK_BYTES = 1024 * 1024 + 16;
const OBJECT_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class CiphertextObjectIntegrityError extends Error {
  constructor() { super("Encrypted object storage integrity check failed"); }
}

export type StoredCiphertextChunk = {
  storageObjectId: string;
  sha256: string;
  byteSize: number;
};

/**
 * Private, create-only ciphertext chunk primitive. It does not authorize a
 * member, prove encryption, enforce quota, or publish a database blob row.
 * A successful write intentionally leaves a read-only pending hard-link alias;
 * backups must select authorized database-referenced final IDs, not glob files.
 * This is not immutable against a process controlling the storage UID.
 */
export async function storeCiphertextChunk(
  root: string,
  householdId: string,
  ciphertext: Uint8Array,
): Promise<StoredCiphertextChunk> {
  assertHouseholdId(householdId);
  if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength < 16 ||
    ciphertext.byteLength > MAX_CIPHERTEXT_CHUNK_BYTES)
    throw new CiphertextObjectIntegrityError();
  const snapshot = Buffer.from(ciphertext);
  const digest = createHash("sha256").update(snapshot).digest("hex");
  const directory = await provisionHouseholdDirectory(root, householdId);
  const storageObjectId = randomBytes(16).toString("hex");
  const pending = join(directory, `pending-${randomUUID()}`);
  const destination = join(directory, storageObjectId);
  let output: Awaited<ReturnType<typeof open>>;
  try {
    output = await open(pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch { throw new CiphertextObjectIntegrityError(); }
  try {
    await output.writeFile(snapshot);
    await output.sync();
    await output.chmod(0o400);
    await output.sync();
  } finally { await output.close(); }
  try { await link(pending, destination); }
  catch { throw new CiphertextObjectIntegrityError(); }
  const parent = await open(directory, "r");
  try { await parent.sync(); }
  finally { await parent.close(); }
  await verifiedRead(destination, digest, snapshot.byteLength);
  return { storageObjectId, sha256: digest, byteSize: snapshot.byteLength };
}

/** Caller must derive household scope and expected hash/size from an authorized DB row. */
export async function readCiphertextChunk(
  root: string,
  householdId: string,
  storageObjectId: string,
  expectedSha256: string,
  expectedByteSize: number,
): Promise<Buffer> {
  assertHouseholdId(householdId);
  if (!OBJECT_ID.test(storageObjectId) || !SHA256.test(expectedSha256) ||
    !Number.isSafeInteger(expectedByteSize) || expectedByteSize < 16 ||
    expectedByteSize > MAX_CIPHERTEXT_CHUNK_BYTES)
    throw new CiphertextObjectIntegrityError();
  const directory = await existingHouseholdDirectory(root, householdId);
  return verifiedRead(join(directory, storageObjectId), expectedSha256, expectedByteSize);
}

async function provisionHouseholdDirectory(root: string, householdId: string): Promise<string> {
  const canonical = await privateDirectory(root);
  const hash = createHash("sha256").update(householdId, "utf8").digest("hex");
  const first = await provisionPrivateDirectory(canonical, hash.slice(0, 2));
  const second = await provisionPrivateDirectory(first, hash.slice(2, 4));
  return provisionPrivateDirectory(second, hash);
}

async function existingHouseholdDirectory(root: string, householdId: string): Promise<string> {
  const canonical = await privateDirectory(root);
  const hash = createHash("sha256").update(householdId, "utf8").digest("hex");
  const first = await privateDirectory(join(canonical, hash.slice(0, 2)));
  const second = await privateDirectory(join(first, hash.slice(2, 4)));
  return privateDirectory(join(second, hash));
}

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CiphertextObjectIntegrityError();
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new CiphertextObjectIntegrityError();
    const canonical = await realpath(path);
    const actual = await lstat(canonical);
    if (!actual.isDirectory() || (actual.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && actual.uid !== process.getuid()))
      throw new CiphertextObjectIntegrityError();
    return canonical;
  } catch { throw new CiphertextObjectIntegrityError(); }
}

async function verifiedRead(path: string, expectedSha256: string,
  expectedByteSize: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new CiphertextObjectIntegrityError(); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedByteSize ||
      (before.mode & 0o777) !== 0o400 ||
      (process.getuid !== undefined && before.uid !== process.getuid()))
      throw new CiphertextObjectIntegrityError();
    const bytes = await readFile(handle);
    const after = await handle.stat();
    if (bytes.byteLength !== expectedByteSize || after.size !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
      throw new CiphertextObjectIntegrityError();
    return bytes;
  } catch { throw new CiphertextObjectIntegrityError(); }
  finally { await handle.close(); }
}

function assertHouseholdId(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })) throw new CiphertextObjectIntegrityError();
}
