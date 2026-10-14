import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { privateFile as assertDatabaseFile, verifySchema } from "../storage/sqliteFamilyTimeline.js";
import { encryptPrivateBackupFile, decryptPrivateBackupFile } from "./privateAgeFile.js";
import { PrivateBundleError, restorePrivateBundle, writePrivateBundle, type PrivateBundleMember } from "./privateBundle.js";

async function privateDirectory(path: string) {
  if (!isAbsolute(path)) throw new PrivateBundleError();
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new PrivateBundleError();
}
async function describe(path: string, kind: PrivateBundleMember["kind"], maxBytes = 1024 * 1024 * 1024): Promise<PrivateBundleMember & { path: string }> {
  await privateDirectory(dirname(path));
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size < 1 || info.size > maxBytes)
      throw new PrivateBundleError();
    const digest = createHash("sha256"); const bytes = Buffer.alloc(64 * 1024); let offset = 0;
    while (offset < info.size) {
      const result = await file.read(bytes, 0, Math.min(bytes.length, info.size - offset), offset);
      if (!result.bytesRead) throw new PrivateBundleError(); digest.update(bytes.subarray(0, result.bytesRead)); offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw new PrivateBundleError();
    return { kind, path, bytes: info.size, sha256: digest.digest("hex") };
  } finally { await file.close(); }
}
function readDatabase(path: string) {
  assertDatabaseFile(path, true); assertDatabaseFile(`${path}-wal`, false); assertDatabaseFile(`${path}-shm`, false);
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  try { db.pragma("foreign_keys = ON"); db.pragma("query_only = ON"); db.pragma("trusted_schema = ON"); verifySchema(db); return db; }
  catch { db.close(); throw new PrivateBundleError(); }
}
function references(db: Database.Database) {
  const rows = db.prepare<[], { sha256: string; bytes: number }>(
    "SELECT DISTINCT s.sha256, s.byte_size bytes FROM source_objects s " +
    "JOIN documents d ON d.source_sha256 = s.sha256 ORDER BY s.sha256",
  ).all();
  if (rows.length > 5000 || rows.some(row => !/^[0-9a-f]{64}$/.test(row.sha256))) throw new PrivateBundleError();
  return rows;
}
async function verifyRestoredState(root: string, members: PrivateBundleMember[]) {
  const db = readDatabase(join(root, "case.sqlite"));
  try {
    if (db.prepare("SELECT 1 FROM sessions WHERE revoked_at IS NULL LIMIT 1").get()) throw new PrivateBundleError();
    const expected = references(db);
    const actual = members.filter(member => member.kind === "object").sort((a, b) => a.sha256.localeCompare(b.sha256));
    if (JSON.stringify(expected) !== JSON.stringify(actual.map(({ sha256, bytes }) => ({ sha256, bytes })))) throw new PrivateBundleError();
    const pepper = members.find(member => member.kind === "recovery_pepper");
    if (!pepper || pepper.bytes !== 32) throw new PrivateBundleError();
  } finally { db.close(); }
}

/** Offline only. Originals and the source database are never modified or migrated. */
export async function createPrivateSnapshot(input: {
  sourceDbPath: string; objectRoot: string; recoveryPepperPath: string;
  snapshotRoot: string; encryptedPath: string; recipient: string; writersStopped: true;
}) {
  try {
    if (input.writersStopped !== true) throw new PrivateBundleError();
    await privateDirectory(input.objectRoot); await privateDirectory(dirname(input.snapshotRoot));
    if (![input.sourceDbPath, input.recoveryPepperPath, input.encryptedPath].every(isAbsolute)) throw new PrivateBundleError();
    const sourceRoot = resolve(dirname(input.sourceDbPath)); const snapshotRoot = resolve(input.snapshotRoot);
    for (const root of [sourceRoot, resolve(input.objectRoot)]) {
      if (snapshotRoot === root || snapshotRoot.startsWith(root + sep) || root.startsWith(snapshotRoot + sep)) throw new PrivateBundleError();
    }
    await mkdir(snapshotRoot, { mode: 0o700 });
    const dbPath = join(snapshotRoot, "case.sqlite");
    const source = readDatabase(input.sourceDbPath);
    try { await source.backup(dbPath); } finally { source.close(); }
    await chmod(dbPath, 0o600);
    const copy = new Database(dbPath, { fileMustExist: true });
    try {
      copy.pragma("foreign_keys = ON"); copy.pragma("trusted_schema = ON"); copy.pragma("journal_mode = DELETE");
      copy.pragma("synchronous = EXTRA"); verifySchema(copy);
      copy.prepare("UPDATE sessions SET revoked_at = max(created_at, ?) WHERE revoked_at IS NULL")
        .run(Math.floor(Date.now() / 1000));
      verifySchema(copy);
    } finally { copy.close(); }
    const dbFile = await open(dbPath, "r"); try { await dbFile.sync(); } finally { await dbFile.close(); }
    const members = [await describe(dbPath, "database"), await describe(input.recoveryPepperPath, "recovery_pepper")];
    const db = readDatabase(dbPath);
    let refs: ReturnType<typeof references>;
    try { refs = references(db); } finally { db.close(); }
    for (const ref of refs) {
      const first = join(input.objectRoot, ref.sha256.slice(0, 2)); await privateDirectory(first);
      const second = join(first, ref.sha256.slice(2, 4)); await privateDirectory(second);
      const member = await describe(join(second, ref.sha256), "object");
      if (member.sha256 !== ref.sha256 || member.bytes !== ref.bytes) throw new PrivateBundleError(); members.push(member);
    }
    const bundlePath = join(snapshotRoot, "bundle");
    await writePrivateBundle({ members, destination: bundlePath });
    return await encryptPrivateBackupFile({ sourcePath: bundlePath, encryptedPath: input.encryptedPath, recipient: input.recipient });
  } catch { throw new PrivateBundleError(); }
}

/** Expected ciphertext hash must be pinned off-host, not supplied by a mutable archive. */
export async function restorePrivateSnapshot(input: {
  encryptedPath: string; expectedSha256: string; identityPath: string; workRoot: string; destinationRoot: string;
}) {
  try {
    if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) throw new PrivateBundleError();
    const encrypted = await describe(input.encryptedPath, "database", 1024 * 1024 * 1024 + 1024 * 1024);
    if (encrypted.sha256 !== input.expectedSha256) throw new PrivateBundleError();
    await privateDirectory(dirname(input.workRoot)); await mkdir(input.workRoot, { mode: 0o700 });
    const bundlePath = join(input.workRoot, "authenticated-bundle");
    await decryptPrivateBackupFile({ encryptedPath: input.encryptedPath, identityPath: input.identityPath, restoredPath: bundlePath });
    return await restorePrivateBundle({ bundlePath, destinationRoot: input.destinationRoot, verifyState: verifyRestoredState });
  } catch { throw new PrivateBundleError(); }
}
