import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

import Database from "better-sqlite3";

import { createCiphertextObjectSnapshot,
  readCiphertextObjectSnapshotReferences,
  restoreCiphertextObjectSnapshot } from "./ciphertextObjectSnapshot.js";
import { readCiphertextChunk } from "./ciphertextObjectStore.js";
import { readCommittedCiphertextReferences } from
  "./committedCiphertextReferences.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";

const ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FORMAT = "adeno.managed-backup-pair.v1";
const DB_NAME = "managed.sqlite3";
const PAIR_NAME = "pair.json";
const MAX_DB_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_PAIR_BYTES = 2048;

export class OfflineManagedBackupPairError extends Error {
  constructor() { super("Managed backup pair is unavailable or invalid"); }
}

export type ManagedBackupPairProof = Readonly<{
  pairSha256: string;
  databaseSha256: string;
  databaseBytes: number;
  objectManifestSha256: string;
  referenceSetSha256: string;
  objectCount: number;
  objectBytes: number;
}>;

type PairManifest = { format: string; snapshotId: string;
  database: { sha256: string; bytes: number };
  objects: { manifestSha256: string; referenceSetSha256: string;
    count: number; bytes: number } };

/**
 * Offline, single-replica pilot primitive. The caller must stop new managed
 * writes, drain in-flight uploads, and retain create-only source objects. It
 * never modifies the source DB or objects. A complete bundle is published
 * only after a SQLite online backup and referenced-object snapshot are synced.
 * The returned hash must be pinned outside this mutable host; it is not a MAC.
 */
export async function createOfflineManagedBackupPair(input: {
  sourceDbPath: string;
  sourceObjectRoot: string;
  backupRoot: string;
  snapshotId: string;
}): Promise<ManagedBackupPairProof> {
  try { return await createPair(input); }
  catch { throw new OfflineManagedBackupPairError(); }
}

async function createPair(input: {
  sourceDbPath: string;
  sourceObjectRoot: string;
  backupRoot: string;
  snapshotId: string;
}): Promise<ManagedBackupPairProof> {
  if (!ID.test(input.snapshotId)) throw new OfflineManagedBackupPairError();
  const backupRoot = await privateDirectory(input.backupRoot);
  const sourceObjectRoot = await privateDirectory(input.sourceObjectRoot);
  const sourceDbPath = await privateFile(input.sourceDbPath, 0o600);
  if (sameOrNested(backupRoot, sourceObjectRoot) ||
    sameOrNested(sourceObjectRoot, backupRoot) ||
    sameOrNested(backupRoot, sourceDbPath) ||
    sameOrNested(sourceDbPath, backupRoot))
    throw new OfflineManagedBackupPairError();
  await assertOptionalPrivateFile(`${sourceDbPath}-wal`);
  await assertOptionalPrivateFile(`${sourceDbPath}-shm`);
  if (await exists(`${sourceDbPath}-journal`))
    throw new OfflineManagedBackupPairError();
  const reserved = join(backupRoot, `reserved-${input.snapshotId}`);
  const pending = join(backupRoot,
    `pending-${input.snapshotId}-${randomUUID()}`);
  const published = join(backupRoot, input.snapshotId);
  await mkdir(reserved, { mode: 0o700 }); // One-shot ID, even on failure.
  await syncDirectory(backupRoot);
  await mkdir(pending, { mode: 0o700 });
  await syncDirectory(backupRoot);
  const dbPath = join(pending, DB_NAME);
  const objectsRoot = join(pending, "objects");
  await mkdir(objectsRoot, { mode: 0o700 });
  await syncDirectory(pending);
  const source = new Database(sourceDbPath, { fileMustExist: true,
    readonly: true, timeout: 5_000 });
  try {
    setReadPragmas(source);
    checkDatabase(source);
    await source.backup(dbPath);
  } finally { source.close(); }
  normalizeBackupJournal(dbPath);
  await sealDatabase(dbPath);
  await syncDirectory(pending);
  const snapshot = openManagedSnapshot(dbPath);
  let references;
  try { references = readCommittedCiphertextReferences(snapshot); }
  finally { snapshot.close(); }
  const objects = await createCiphertextObjectSnapshot({
    sourceRoot: sourceObjectRoot, backupRoot: objectsRoot,
    snapshotId: input.snapshotId, references,
  });
  const database = await hashPrivateFile(dbPath, MAX_DB_BYTES, 0o400);
  const manifest: PairManifest = { format: FORMAT,
    snapshotId: input.snapshotId,
    database: { sha256: database.sha256, bytes: database.bytes },
    objects: { manifestSha256: objects.manifestSha256,
      referenceSetSha256: referenceHash(references),
      count: objects.objectCount, bytes: objects.totalBytes } };
  const pairBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (pairBytes.byteLength > MAX_PAIR_BYTES)
    throw new OfflineManagedBackupPairError();
  const pairSha256 = createHash("sha256").update(pairBytes).digest("hex");
  const pairFile = await open(join(pending, PAIR_NAME),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600);
  try {
    await pairFile.writeFile(pairBytes);
    await pairFile.sync();
    await pairFile.chmod(0o400);
    await pairFile.sync();
  } finally { await pairFile.close(); }
  await syncDirectory(pending);
  if (await exists(published)) throw new OfflineManagedBackupPairError();
  await rename(pending, published);
  await syncDirectory(backupRoot);
  return { pairSha256, databaseSha256: database.sha256,
    databaseBytes: database.bytes, objectManifestSha256: objects.manifestSha256,
    referenceSetSha256: manifest.objects.referenceSetSha256,
    objectCount: objects.objectCount, objectBytes: objects.totalBytes };
}

/** Verify exact DB/object membership against an externally pinned pair hash. */
export async function verifyOfflineManagedBackupPair(input: {
  backupRoot: string;
  snapshotId: string;
  expectedPairSha256: string;
}): Promise<ManagedBackupPairProof> {
  try { return await verifyPair(input); }
  catch { throw new OfflineManagedBackupPairError(); }
}

/**
 * Restore a verified pair to new private paths. This does not mount it: an
 * independent current-head/key witness and deployment startup gate are still
 * required before serving users.
 */
export async function restoreOfflineManagedBackupPair(input: {
  backupRoot: string;
  snapshotId: string;
  expectedPairSha256: string;
  targetParent: string;
}): Promise<ManagedBackupPairProof & { targetRoot: string;
  databasePath: string; objectRoot: string }> {
  try { return await restorePair(input); }
  catch { throw new OfflineManagedBackupPairError(); }
}

async function restorePair(input: {
  backupRoot: string;
  snapshotId: string;
  expectedPairSha256: string;
  targetParent: string;
}): Promise<ManagedBackupPairProof & { targetRoot: string;
  databasePath: string; objectRoot: string }> {
  const proof = await verifyOfflineManagedBackupPair(input);
  const backupRoot = await privateDirectory(input.backupRoot);
  const targetParent = await privateDirectory(input.targetParent);
  if (sameOrNested(targetParent, backupRoot) ||
    sameOrNested(backupRoot, targetParent))
    throw new OfflineManagedBackupPairError();
  const suffix = randomUUID();
  const pending = join(targetParent,
    `pending-pair-restore-${input.snapshotId}-${suffix}`);
  const published = join(targetParent,
    `restored-pair-${input.snapshotId}-${suffix}`);
  await mkdir(pending, { mode: 0o700 });
  await syncDirectory(targetParent);
  const sourceDbPath = join(backupRoot, input.snapshotId, DB_NAME);
  const databasePath = join(pending, DB_NAME);
  await copyPinnedDatabase(sourceDbPath, databasePath,
    proof.databaseSha256, proof.databaseBytes);
  await syncDirectory(pending);
  const restoredObjects = await restoreCiphertextObjectSnapshot({
    backupRoot: join(backupRoot, input.snapshotId, "objects"),
    snapshotId: input.snapshotId,
    expectedManifestSha256: proof.objectManifestSha256,
    targetParent: pending,
  });
  if (restoredObjects.objectCount !== proof.objectCount ||
    restoredObjects.totalBytes !== proof.objectBytes)
    throw new OfflineManagedBackupPairError();
  const snapshot = openManagedSnapshot(databasePath);
  let references;
  try { references = readCommittedCiphertextReferences(snapshot); }
  finally { snapshot.close(); }
  if (referenceHash(references) !== proof.referenceSetSha256)
    throw new OfflineManagedBackupPairError();
  for (const reference of references) {
    await readCiphertextChunk(restoredObjects.targetRoot,
      reference.householdId, reference.storageObjectId,
      reference.sha256, reference.byteSize);
  }
  await assertNoSidecars(databasePath);
  const marker = Buffer.from(JSON.stringify({
    format: "adeno.managed-pair-restore.v1",
    snapshotId: input.snapshotId, pairSha256: proof.pairSha256,
    databaseSha256: proof.databaseSha256,
    objectRoot: basename(restoredObjects.targetRoot),
  }), "utf8");
  const handle = await open(join(pending, ".restore-complete"),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600);
  try {
    await handle.writeFile(marker);
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(pending);
  await rename(pending, published);
  await syncDirectory(targetParent);
  return { ...proof, targetRoot: published,
    databasePath: join(published, DB_NAME),
    objectRoot: join(published, basename(restoredObjects.targetRoot)) };
}

async function verifyPair(input: {
  backupRoot: string;
  snapshotId: string;
  expectedPairSha256: string;
}): Promise<ManagedBackupPairProof> {
  if (!ID.test(input.snapshotId) || !SHA256.test(input.expectedPairSha256))
    throw new OfflineManagedBackupPairError();
  const root = await privateDirectory(input.backupRoot);
  const bundle = await privateDirectory(join(root, input.snapshotId));
  if (JSON.stringify((await readdir(bundle)).sort()) !==
    JSON.stringify([DB_NAME, "objects", PAIR_NAME].sort()))
    throw new OfflineManagedBackupPairError();
  const pair = await readPrivateFile(join(bundle, PAIR_NAME), MAX_PAIR_BYTES, 0o400);
  const pairSha256 = createHash("sha256").update(pair).digest("hex");
  if (pairSha256 !== input.expectedPairSha256)
    throw new OfflineManagedBackupPairError();
  let manifest: PairManifest;
  try { manifest = JSON.parse(pair.toString("utf8")) as PairManifest; }
  catch { throw new OfflineManagedBackupPairError(); }
  if (!validManifest(manifest, input.snapshotId) ||
    JSON.stringify(manifest) !== pair.toString("utf8"))
    throw new OfflineManagedBackupPairError();
  const dbPath = join(bundle, DB_NAME);
  await assertNoSidecars(dbPath);
  const database = await hashPrivateFile(dbPath, MAX_DB_BYTES, 0o400);
  if (database.sha256 !== manifest.database.sha256 ||
    database.bytes !== manifest.database.bytes)
    throw new OfflineManagedBackupPairError();
  const snapshot = openManagedSnapshot(dbPath);
  let references;
  try { references = readCommittedCiphertextReferences(snapshot); }
  finally { snapshot.close(); }
  await assertNoSidecars(dbPath);
  const objectsRoot = await privateDirectory(join(bundle, "objects"));
  if (JSON.stringify((await readdir(objectsRoot)).sort()) !==
    JSON.stringify([input.snapshotId, `reserved-${input.snapshotId}`].sort()) ||
    (await readdir(await privateDirectory(join(objectsRoot,
      `reserved-${input.snapshotId}`)))).length !== 0)
    throw new OfflineManagedBackupPairError();
  const objectReferences = await readCiphertextObjectSnapshotReferences({
    backupRoot: objectsRoot, snapshotId: input.snapshotId,
    expectedManifestSha256: manifest.objects.manifestSha256,
  });
  if (!sameReferences(references, objectReferences) ||
    referenceHash(references) !== manifest.objects.referenceSetSha256 ||
    objectReferences.length !== manifest.objects.count ||
    objectReferences.reduce((sum, row) => sum + row.byteSize, 0) !==
      manifest.objects.bytes)
    throw new OfflineManagedBackupPairError();
  return { pairSha256, databaseSha256: database.sha256,
    databaseBytes: database.bytes,
    objectManifestSha256: manifest.objects.manifestSha256,
    referenceSetSha256: manifest.objects.referenceSetSha256,
    objectCount: manifest.objects.count, objectBytes: manifest.objects.bytes };
}

function openManagedSnapshot(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true,
    timeout: 5_000 });
  try { setReadPragmas(db); checkDatabase(db); return db; }
  catch { db.close(); throw new OfflineManagedBackupPairError(); }
}

function normalizeBackupJournal(path: string): void {
  const db = new Database(path, { fileMustExist: true, timeout: 5_000 });
  try {
    setReadPragmas(db);
    if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete")
      throw new OfflineManagedBackupPairError();
    db.pragma("synchronous = EXTRA");
    checkDatabase(db);
  } finally { db.close(); }
}

function setReadPragmas(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
}

function checkDatabase(db: Database.Database): void {
  assertManagedSchema(db);
  if (db.prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
    .get()?.integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").get() !== undefined)
    throw new OfflineManagedBackupPairError();
}

function sameReferences(first: readonly { householdId: string;
  storageObjectId: string; sha256: string; byteSize: number }[],
second: readonly { householdId: string; storageObjectId: string;
  sha256: string; byteSize: number }[]): boolean {
  const key = (row: typeof first[number]) =>
    `${row.householdId}:${row.storageObjectId}:${row.sha256}:${row.byteSize}`;
  return JSON.stringify(first.map(key).sort()) ===
    JSON.stringify(second.map(key).sort());
}

function referenceHash(rows: readonly { householdId: string;
  storageObjectId: string; sha256: string; byteSize: number }[]): string {
  const canonical = rows.map((row) => [row.householdId,
    row.storageObjectId, row.sha256, row.byteSize]).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function validManifest(value: PairManifest, snapshotId: string): boolean {
  return Boolean(value && typeof value === "object" &&
    Object.keys(value).sort().join(",") === "database,format,objects,snapshotId" &&
    value.format === FORMAT && value.snapshotId === snapshotId &&
    value.database && typeof value.database === "object" &&
    Object.keys(value.database).sort().join(",") === "bytes,sha256" &&
    SHA256.test(value.database.sha256) &&
    Number.isSafeInteger(value.database.bytes) &&
    value.database.bytes > 0 && value.database.bytes <= MAX_DB_BYTES &&
    value.objects && typeof value.objects === "object" &&
    Object.keys(value.objects).sort().join(",") ===
      "bytes,count,manifestSha256,referenceSetSha256" &&
    SHA256.test(value.objects.manifestSha256) &&
    SHA256.test(value.objects.referenceSetSha256) &&
    Number.isSafeInteger(value.objects.count) &&
    value.objects.count >= 0 && value.objects.count <= 100_000 &&
    Number.isSafeInteger(value.objects.bytes) &&
    value.objects.bytes >= 0 && value.objects.bytes <= 10 * 1024 * 1024 * 1024);
}

async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new OfflineManagedBackupPairError();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new OfflineManagedBackupPairError();
  return realpath(path);
}

async function privateFile(path: string, mode: number): Promise<string> {
  if (!isAbsolute(path)) throw new OfflineManagedBackupPairError();
  const parent = await privateDirectory(dirname(path));
  const canonical = await realpath(path);
  if (canonical !== join(parent, basename(path)))
    throw new OfflineManagedBackupPairError();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== mode ||
    (process.getuid !== undefined && info.uid !== process.getuid()))
    throw new OfflineManagedBackupPairError();
  return canonical;
}

async function assertOptionalPrivateFile(path: string): Promise<void> {
  try { await lstat(path); }
  catch (error) { if (isMissing(error)) return; throw error; }
  await privateFile(path, 0o600);
}

async function assertNoSidecars(path: string): Promise<void> {
  if (await exists(`${path}-wal`) || await exists(`${path}-shm`) ||
    await exists(`${path}-journal`)) throw new OfflineManagedBackupPairError();
}

async function sealDatabase(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > MAX_DB_BYTES ||
      (process.getuid !== undefined && info.uid !== process.getuid()))
      throw new OfflineManagedBackupPairError();
    await handle.sync();
    await handle.chmod(0o400);
    await handle.sync();
  } finally { await handle.close(); }
  await assertNoSidecars(path);
}

async function hashPrivateFile(path: string, limit: number, mode: number):
  Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit ||
      (before.mode & 0o777) !== mode ||
      (process.getuid !== undefined && before.uid !== process.getuid()))
      throw new OfflineManagedBackupPairError();
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0,
        Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead === 0) throw new OfflineManagedBackupPairError();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.dev !== before.dev ||
      after.ino !== before.ino)
      throw new OfflineManagedBackupPairError();
    return { sha256: hash.digest("hex"), bytes: offset };
  } finally { await handle.close(); }
}

async function copyPinnedDatabase(source: string, destination: string,
  expectedSha256: string, expectedBytes: number): Promise<void> {
  const from = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await from.stat();
    if (!before.isFile() || before.size !== expectedBytes ||
      (before.mode & 0o777) !== 0o400 ||
      (process.getuid !== undefined && before.uid !== process.getuid()))
      throw new OfflineManagedBackupPairError();
    const to = await open(destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < expectedBytes) {
        const { bytesRead } = await from.read(buffer, 0,
          Math.min(buffer.length, expectedBytes - offset), offset);
        if (bytesRead === 0) throw new OfflineManagedBackupPairError();
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await to.write(buffer, written,
            bytesRead - written, offset + written);
          if (result.bytesWritten === 0) throw new OfflineManagedBackupPairError();
          written += result.bytesWritten;
        }
        offset += bytesRead;
      }
      const after = await from.stat();
      if (after.size !== before.size || after.dev !== before.dev ||
        after.ino !== before.ino || hash.digest("hex") !== expectedSha256)
        throw new OfflineManagedBackupPairError();
      await to.sync();
      await to.chmod(0o400);
      await to.sync();
    } finally { await to.close(); }
  } finally { await from.close(); }
  const copied = await hashPrivateFile(destination, MAX_DB_BYTES, 0o400);
  if (copied.sha256 !== expectedSha256 || copied.bytes !== expectedBytes)
    throw new OfflineManagedBackupPairError();
}

async function readPrivateFile(path: string, limit: number, mode: number):
  Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > limit ||
      (before.mode & 0o777) !== mode ||
      (process.getuid !== undefined && before.uid !== process.getuid()))
      throw new OfflineManagedBackupPairError();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino)
      throw new OfflineManagedBackupPairError();
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isMissing(error)) return false; throw error; }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ENOENT";
}

function sameOrNested(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${sep}`);
}
