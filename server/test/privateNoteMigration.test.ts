import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const cli = join(serverRoot, "dist/runPrivateNoteMigration.js");
const sql = fileURLToPath(new URL("../../app/storage/migrations/0008_note_provenance.sql", import.meta.url));
it("requires explicit opt-in, applies the exact additive migration once and refuses changed SQL", () => {
  const root = mkdtempSync(join(tmpdir(), "adeno-fictional-note-migration-"));
  const data = join(root, "data");
  execFileSync(process.execPath, [join(serverRoot, "test/createPrivateSyntheticDatabase.mjs"), data], {
    env: { ...process.env, ADENO_SYNTHETIC_MIGRATIONS_APPROVED: "0001-0007" }, stdio: "pipe",
  });
  const database = join(data, "case.sqlite");
  const run = (approved: string, source = sql) => spawnSync(process.execPath, [cli, database, source], {
    env: { ...process.env, ADENO_NOTE_MIGRATION_APPROVED: approved }, encoding: "utf8", timeout: 10000,
  });
  expect(run("").status).toBe(1);
  let reader = new Database(database, { readonly: true });
  expect(reader.pragma("user_version", { simple: true })).toBe(7); reader.close();
  const changed = join(root, "changed.sql"); writeFileSync(changed, "CREATE TABLE unapproved (id TEXT);");
  expect(run("0008", changed).status).toBe(1);
  const applied = run("0008"); expect(applied.status).toBe(0); expect(JSON.parse(applied.stdout)).toMatchObject({ migration: 8, applied: true });
  const repeat = run("0008"); expect(repeat.status).toBe(0); expect(JSON.parse(repeat.stdout)).toMatchObject({ applied: false });
  reader = new Database(database, { readonly: true });
  try {
    expect(reader.pragma("user_version", { simple: true })).toBe(8);
    expect(reader.prepare("SELECT count(*) count FROM family_note_provenance").get()).toEqual({ count: 0 });
    expect(reader.prepare("SELECT count(*) count FROM schema_migrations WHERE version = 8").get()).toEqual({ count: 1 });
    expect(reader.prepare("SELECT name FROM sqlite_master WHERE name = 'unapproved'").get()).toBeUndefined();
  } finally { reader.close(); }
});
