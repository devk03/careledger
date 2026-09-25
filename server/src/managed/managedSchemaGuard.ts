import type Database from "better-sqlite3";

import { MANAGED_APPLICATION_ID, MANAGED_MIGRATIONS } from
  "./managedSchemaManifest.js";

type MigrationRow = { version: number; name: string; sha256: string };

export class IncompatibleManagedSchema extends Error {
  constructor() {
    super("The managed database schema is unavailable or incompatible.");
    this.name = "IncompatibleManagedSchema";
  }
}

/** Identity/checksum check for an already opened private managed connection. */
export function assertManagedSchema(db: Database.Database): void {
  if (db.pragma("foreign_keys", { simple: true }) !== 1 ||
    db.pragma("trusted_schema", { simple: true }) !== 0 ||
    db.pragma("application_id", { simple: true }) !== MANAGED_APPLICATION_ID ||
    db.pragma("user_version", { simple: true }) !== MANAGED_MIGRATIONS.length)
    throw new IncompatibleManagedSchema();
  const rows = db.prepare<[], MigrationRow>(
    "SELECT version, name, sha256 FROM managed_schema_migrations ORDER BY version",
  ).all();
  if (rows.length !== MANAGED_MIGRATIONS.length || rows.some((row, index) => {
    const expected = MANAGED_MIGRATIONS[index];
    return !expected || row.version !== expected[0] ||
      row.name !== expected[1] || row.sha256 !== expected[2];
  })) throw new IncompatibleManagedSchema();
}
