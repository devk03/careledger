// Operator-run fixture only. Requires explicit approval for existing migrations.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import Database from "better-sqlite3";

process.umask(0o077);
const root = process.argv[2];
if (process.env.ADENO_SYNTHETIC_MIGRATIONS_APPROVED !== "0001-0007" ||
    process.argv.length !== 3 || !root || !isAbsolute(root))
  throw new Error("Explicit synthetic migration approval and a new absolute directory required");
mkdirSync(root, { mode: 0o700 }); // Existing directories are never accepted.
writeFileSync(join(root, "SYNTHETIC_ONLY"), "Independently invented acceptance fixture; never use for production.\n", { flag: "wx", mode: 0o600 });
const names = ["initial", "cross_scope_guards", "extraction_job_uniqueness",
  "workflow_actor_guards", "managed_e2ee_sync", "sparse_care_days", "family_day_access"];
const db = new Database(join(root, "case.sqlite"));
try {
  db.pragma("foreign_keys = ON"); db.pragma("trusted_schema = ON");
  for (const [index, name] of names.entries()) {
    const filename = `${String(index + 1).padStart(4, "0")}_${name}.sql`;
    const sql = readFileSync(new URL(`../../app/storage/migrations/${filename}`, import.meta.url), "utf8");
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (version, name, sha256, app_version, applied_at) VALUES (?, ?, ?, 'synthetic-acceptance', ?)")
      .run(index + 1, name, createHash("sha256").update(sql).digest("hex"), Math.floor(Date.now() / 1000));
  }
  db.pragma("application_id = 1129071687"); db.pragma("user_version = 7");
} finally { db.close(); }
chmodSync(join(root, "case.sqlite"), 0o600);
console.log(JSON.stringify({ synthetic: true, versions: [1, 2, 3, 4, 5, 6, 7] }));
