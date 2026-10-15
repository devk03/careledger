import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import Database from "better-sqlite3";
import { privateFile, verifySchema, PRIVATE_SCHEMA_MIGRATIONS } from "./storage/sqliteFamilyTimeline.js";

/** Explicit offline operator command; never imported by application startup. */
process.umask(0o077);
let db: Database.Database | undefined;
try {
  if (process.env.ADENO_NOTE_MIGRATION_APPROVED !== "0008" || process.argv.length !== 4)
    throw new Error("Explicit migration approval required");
  const databasePath = process.argv[2]!; const sqlPath = process.argv[3]!;
  if (![databasePath, sqlPath].every(isAbsolute)) throw new Error("Absolute paths required");
  privateFile(databasePath, true); privateFile(`${databasePath}-wal`, false); privateFile(`${databasePath}-shm`, false);
  const source = await open(sqlPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let sql: string;
  const migration = PRIVATE_SCHEMA_MIGRATIONS.find(entry => entry[0] === 8)!;
  try {
    const info = await source.stat();
    if (!info.isFile() || info.size < 1 || info.size > 64 * 1024) throw new Error("Invalid migration file");
    const bytes = await source.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== migration[2]) throw new Error("Migration digest mismatch");
    sql = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally { await source.close(); }
  db = new Database(databasePath, { fileMustExist: true, timeout: 5000 });
  db.pragma("foreign_keys = ON"); db.pragma("trusted_schema = ON"); db.pragma("synchronous = EXTRA");
  verifySchema(db);
  const applied = db.transaction(() => {
    verifySchema(db!);
    if (db!.pragma("user_version", { simple: true }) === 8) return false;
    db!.exec(sql);
    db!.prepare("INSERT INTO schema_migrations (version, name, sha256, app_version, applied_at) VALUES (8, ?, ?, 'private-note-provenance-0008', ?)")
      .run(migration[1], migration[2], Math.floor(Date.now() / 1000));
    db!.pragma("user_version = 8");
    verifySchema(db!);
    return true;
  }).immediate();
  process.stdout.write(`${JSON.stringify({ migration: 8, applied, integrity: "ok" })}\n`);
} catch {
  process.stderr.write("Note provenance migration failed; no unverified migration is accepted.\n");
  process.exitCode = 1;
} finally { db?.close(); }
