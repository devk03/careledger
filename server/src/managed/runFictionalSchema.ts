import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

const APPLICATION_ID = 0x41444e4f; // "ADNO", separate from community "CLDG".
const MIGRATIONS = [
  [1, "identity_scopes", "96e1b5541389650818a961f81eda1696929721b99a454f364ac3ce17d623721b"],
  [2, "ciphertext_intake", "c727c2c1a4479a723753313fd2455e457c49e8c5361a71da63d8d2b6551ceae4"],
  [3, "day_revisions", "a51fdb6b99c0f49776e00effbfe97f39e4d9149317ee021139b076e913c71ac8"],
] as const;

/**
 * Operator-only fictional schema smoke-test entrypoint. It always allocates a
 * new private temporary database. It never opens a caller-supplied path,
 * existing family volume, or production database. The explicit environment
 * gate is not a substitute for the maintainer's separate application approval.
 * DO NOT run it before that approval is recorded.
 */
function main(): void {
  if (process.argv.length !== 3 || process.argv[2] !== "--new-fictional-db" ||
    process.env.ADENO_APPROVED_FICTIONAL_MIGRATION !== "1" ||
    process.env.NODE_ENV === "production" ||
    Object.keys(process.env).some((name) => name.startsWith("RAILWAY_")))
    throw new Error("Fictional managed migration requires explicit approval and opt-in");

  const statements = MIGRATIONS.map(([version, name, sha256]) => {
    const file = new URL(`../../migrations/managed/${String(version).padStart(4, "0")}_${name}.sql`,
      import.meta.url);
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256)
      throw new Error("Managed migration checksum mismatch");
    return { version, name, sha256, sql: bytes.toString("utf8") };
  });
  const previousUmask = process.umask(0o077);
  try {
    const directory = mkdtempSync(join(tmpdir(), "adeno-fictional-managed-"));
    const path = join(directory, "managed.sqlite3");
    try {
      const db = new Database(path, { timeout: 5_000 });
      try {
        db.pragma("foreign_keys = ON");
        db.pragma("trusted_schema = OFF");
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec("CREATE TABLE managed_schema_migrations (" +
            "version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, " +
            "applied_at INTEGER NOT NULL) STRICT");
          for (const migration of statements) {
            db.exec(migration.sql);
            db.prepare("INSERT INTO managed_schema_migrations " +
              "(version, name, sha256, applied_at) VALUES (?, ?, ?, unixepoch('now'))")
              .run(migration.version, migration.name, migration.sha256);
          }
          db.pragma(`application_id = ${APPLICATION_ID}`);
          db.pragma(`user_version = ${MIGRATIONS.length}`);
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* Preserve the migration failure. */ }
          throw error;
        }
        const integrity = db.prepare<[], { integrity_check: string }>("PRAGMA integrity_check").get();
        const badForeignKey = db.prepare("PRAGMA foreign_key_check").get();
        if (integrity?.integrity_check !== "ok" || badForeignKey !== undefined)
          throw new Error("Fictional managed schema integrity failed");
      } finally {
        db.close();
      }
      process.stdout.write(`Fictional managed database created at ${path}\n`);
    } catch (error) {
      process.stderr.write(`Fictional test directory retained for inspection: ${directory}\n`);
      throw error;
    }
  } finally {
    process.umask(previousUmask);
  }
}

main();
