import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename } from
  "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import { provisionPrivateDirectory } from "../ingest/privateDirectory.js";
import { readCiphertextChunk } from "./ciphertextObjectStore.js";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FORMAT = "adeno.ciphertext-object-snapshot.v1";
const MAX_OBJECTS = 100_000;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 25 * 1024 * 1024;
const MAX_OBJECT_BYTES = 1024 * 1024 + 16;

export class CiphertextSnapshotError extends Error {
  constructor() { super("Ciphertext snapshot is unavailable or invalid"); }
}

export type CiphertextObjectReference = {
  householdId: string;
  storageObjectId: string;
  sha256: string;
  byteSize: number;
};

export type CiphertextSnapshotProof = {
  manifestSha256: string;
  objectCount: number;
  totalBytes: number;
};

/**
 * Only references from a consistent committed-database snapshot may be passed.
 * This routine never lists the source object directory, so pending aliases and
 * aborted objects cannot enter the snapshot by accident. The caller must back
 * up the matching DB snapshot separately and durably anchor the returned hash.
 */
export async function createCiphertextObjectSnapshot(input: {
  sourceRoot: string;
  backupRoot: string;
  snapshotId: string;
  references: readonly CiphertextObjectReference[];
}): Promise<CiphertextSnapshotProof> {
  if (!OPAQUE_ID.test(input.snapshotId)) throw new CiphertextSnapshotError();
  const references = canonicalReferences(input.references);
  const sourceRoot = await privateDirectory(input.sourceRoot);
  const backupRoot = await privateDirectory(input.backupRoot);
  if (sourceRoot === backupRoot) throw new CiphertextSnapshotError();
  const directory = join(backupRoot, `pending-${input.snapshotId}-${randomUUID()}`);
  const finalDirectory = join(backupRoot, input.snapshotId);
  const reservation = join(backupRoot, `reserved-${input.snapshotId}`);
  try {
    await mkdir(reservation, { mode: 0o700 }); // An ID is one-shot, even after failure.
    await syncDirectory(backupRoot);
    await mkdir(directory, { mode: 0o700 }); // Never visible as a finished snapshot.
    await syncDirectory(backupRoot);
    for (const reference of references) {
      const bytes = await readCiphertextChunk(sourceRoot, reference.householdId,
        reference.storageObjectId, reference.sha256, reference.byteSize);
      const filename = objectFilename(reference);
      const output = await open(join(directory, filename),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600);
      try {
        await output.writeFile(bytes);
        await output.sync();
        await output.chmod(0o400);
        await output.sync();
      } finally { await output.close(); }
    }
    const manifest = Buffer.from(JSON.stringify({ format: FORMAT,
      snapshotId: input.snapshotId, objects: references }), "utf8");
    if (manifest.byteLength > MAX_MANIFEST_BYTES) throw new CiphertextSnapshotError();
    const manifestSha256 = createHash("sha256").update(manifest).digest("hex");
    const output = await open(join(directory, "manifest.json"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    try {
      await output.writeFile(manifest);
      await output.sync();
      await output.chmod(0o400);
      await output.sync();
    }
    finally { await output.close(); }
    await syncDirectory(directory);
    try {
      await lstat(finalDirectory);
      throw new CiphertextSnapshotError();
    } catch (error) {
      if (!(typeof error === "object" && error !== null &&
        "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(directory, finalDirectory);
    await syncDirectory(backupRoot);
    return { manifestSha256, objectCount: references.length,
      totalBytes: references.reduce((sum, reference) => sum + reference.byteSize, 0) };
  } catch { throw new CiphertextSnapshotError(); }
}

/** Verification reads only the authenticated manifest's referenced files. */
export async function verifyCiphertextObjectSnapshot(input: {
  backupRoot: string;
  snapshotId: string;
  expectedManifestSha256: string;
}): Promise<CiphertextSnapshotProof> {
  return (await loadVerifiedSnapshot(input)).proof;
}

/**
 * Create a new private object root under a trusted parent, preserving opaque
 * IDs. The caller must separately restore/verify the corresponding database
 * snapshot before mounting it. Partial roots retain a pending-restore name.
 */
export async function restoreCiphertextObjectSnapshot(input: {
  backupRoot: string;
  snapshotId: string;
  expectedManifestSha256: string;
  targetParent: string;
}): Promise<CiphertextSnapshotProof & { targetRoot: string }> {
  const verified = await loadVerifiedSnapshot(input);
  const targetParent = await privateDirectory(input.targetParent);
  const backupRoot = await privateDirectory(input.backupRoot);
  if (sameOrNested(targetParent, backupRoot) || sameOrNested(backupRoot, targetParent))
    throw new CiphertextSnapshotError();
  const suffix = randomUUID();
  const targetRoot = join(targetParent, `pending-restore-${input.snapshotId}-${suffix}`);
  const finalRoot = join(targetParent, `restored-${input.snapshotId}-${suffix}`);
  try {
    await mkdir(targetRoot, { mode: 0o700 });
    await syncDirectory(targetParent);
    for (const reference of verified.references) {
      const bytes = await checkedFile(join(verified.directory, objectFilename(reference)),
        0o400, reference.byteSize);
      if (bytes.byteLength !== reference.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== reference.sha256)
        throw new CiphertextSnapshotError();
      const hash = createHash("sha256").update(reference.householdId).digest("hex");
      const first = await provisionPrivateDirectory(targetRoot, hash.slice(0, 2));
      const second = await provisionPrivateDirectory(first, hash.slice(2, 4));
      const householdDirectory = await provisionPrivateDirectory(second, hash);
      const output = await open(join(householdDirectory, reference.storageObjectId),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600);
      try {
        await output.writeFile(bytes);
        await output.sync();
        await output.chmod(0o400);
        await output.sync();
      } finally { await output.close(); }
      await syncDirectory(householdDirectory);
    }
    for (const reference of verified.references) {
      await readCiphertextChunk(targetRoot, reference.householdId,
        reference.storageObjectId, reference.sha256, reference.byteSize);
    }
    const markerBytes = Buffer.from(JSON.stringify({ format: "adeno.object-restore.v1",
      snapshotId: input.snapshotId, manifestSha256: verified.proof.manifestSha256 }));
    const marker = await open(join(targetRoot, ".restore-marker-pending"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    try {
      await marker.writeFile(markerBytes);
      await marker.sync();
      await marker.chmod(0o400);
      await marker.sync();
    } finally { await marker.close(); }
    await link(join(targetRoot, ".restore-marker-pending"),
      join(targetRoot, ".restore-complete"));
    await syncDirectory(targetRoot);
    const completed = await checkedFile(join(targetRoot, ".restore-complete"),
      0o400, markerBytes.length);
    if (!completed.equals(markerBytes)) throw new CiphertextSnapshotError();
    await rename(targetRoot, finalRoot);
    await syncDirectory(targetParent);
    return { ...verified.proof, targetRoot: finalRoot };
  } catch { throw new CiphertextSnapshotError(); }
}

async function loadVerifiedSnapshot(input: {
  backupRoot: string;
  snapshotId: string;
  expectedManifestSha256: string;
}): Promise<{ proof: CiphertextSnapshotProof;
  references: CiphertextObjectReference[]; directory: string }> {
  if (!OPAQUE_ID.test(input.snapshotId) || !SHA256.test(input.expectedManifestSha256))
    throw new CiphertextSnapshotError();
  const root = await privateDirectory(input.backupRoot);
  const directory = await privateDirectory(join(root, input.snapshotId));
  const bytes = await checkedFile(join(directory, "manifest.json"), 0o400,
    MAX_MANIFEST_BYTES);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== input.expectedManifestSha256)
    throw new CiphertextSnapshotError();
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new CiphertextSnapshotError(); }
  if (!isManifest(value, input.snapshotId)) throw new CiphertextSnapshotError();
  const references = canonicalReferences(value.objects);
  if (JSON.stringify(references) !== JSON.stringify(value.objects))
    throw new CiphertextSnapshotError();
  const expectedNames = ["manifest.json", ...references.map(objectFilename)].sort();
  const actualNames = (await readdir(directory)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames))
    throw new CiphertextSnapshotError();
  for (const reference of references) {
    const object = await checkedFile(join(directory, objectFilename(reference)),
      0o400, reference.byteSize);
    if (object.byteLength !== reference.byteSize ||
      createHash("sha256").update(object).digest("hex") !== reference.sha256)
      throw new CiphertextSnapshotError();
  }
  return { proof: { manifestSha256, objectCount: references.length,
    totalBytes: references.reduce((sum, reference) => sum + reference.byteSize, 0) },
    references, directory };
}

function sameOrNested(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}

function canonicalReferences(input: readonly CiphertextObjectReference[]):
  CiphertextObjectReference[] {
  if (!Array.isArray(input) || input.length > MAX_OBJECTS)
    throw new CiphertextSnapshotError();
  const seen = new Set<string>();
  let total = 0;
  const result: CiphertextObjectReference[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) throw new CiphertextSnapshotError();
    const value = input[index];
    if (!value || typeof value !== "object" ||
      typeof value.householdId !== "string" || !OPAQUE_ID.test(value.householdId) ||
      typeof value.storageObjectId !== "string" || !OPAQUE_ID.test(value.storageObjectId) ||
      typeof value.sha256 !== "string" || !SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.byteSize) || value.byteSize < 16 ||
      value.byteSize > MAX_OBJECT_BYTES)
      throw new CiphertextSnapshotError();
    const identity = `${value.householdId}:${value.storageObjectId}`;
    if (seen.has(identity)) throw new CiphertextSnapshotError();
    seen.add(identity);
    total += value.byteSize;
    if (total > MAX_TOTAL_BYTES) throw new CiphertextSnapshotError();
    result.push({ householdId: value.householdId, storageObjectId: value.storageObjectId,
      sha256: value.sha256, byteSize: value.byteSize });
  }
  return result.sort((a, b) => objectFilename(a) < objectFilename(b) ? -1 :
    objectFilename(a) > objectFilename(b) ? 1 : 0);
}

function objectFilename(value: CiphertextObjectReference): string {
  return `${value.householdId}-${value.storageObjectId}`;
}

function isManifest(value: unknown, snapshotId: string):
  value is { format: string; snapshotId: string; objects: CiphertextObjectReference[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "format,objects,snapshotId" &&
    row.format === FORMAT && row.snapshotId === snapshotId && Array.isArray(row.objects);
}

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new CiphertextSnapshotError();
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new CiphertextSnapshotError();
    const canonical = await realpath(path);
    const actual = await lstat(canonical);
    if (!actual.isDirectory() || (actual.mode & 0o077) !== 0 ||
      (process.getuid !== undefined && actual.uid !== process.getuid()))
      throw new CiphertextSnapshotError();
    return canonical;
  } catch { throw new CiphertextSnapshotError(); }
}

async function checkedFile(path: string, mode: number, limit: number): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new CiphertextSnapshotError(); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || (before.mode & 0o777) !== mode ||
      (process.getuid !== undefined && before.uid !== process.getuid()))
      throw new CiphertextSnapshotError();
    const bytes = await readFile(handle);
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || after.dev !== before.dev ||
      after.ino !== before.ino || after.size !== before.size)
      throw new CiphertextSnapshotError();
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}
