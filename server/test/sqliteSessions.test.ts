import { createHash } from "node:crypto";
import { chmodSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { readCookieSession, SESSION_COOKIE_NAME, sessionTokenSha256 } from "../src/auth/cookieSession.js";
import { IncompatibleSessionDatabase, SqliteSessionRepository } from "../src/storage/sqliteSessions.js";

const migrations = [
  [1, "initial", "0001_initial.sql"],
  [2, "cross_scope_guards", "0002_cross_scope_guards.sql"],
  [3, "extraction_job_uniqueness", "0003_extraction_job_uniqueness.sql"],
  [4, "workflow_actor_guards", "0004_workflow_actor_guards.sql"],
  [5, "managed_e2ee_sync", "0005_managed_e2ee_sync.sql"],
] as const;
const migrationDirectory = fileURLToPath(new URL("../../app/storage/migrations/", import.meta.url));
const token = "f".repeat(43);

function fictionalV5Database(): string {
  const path = join(mkdtempSync(join(tmpdir(), "adeno-fictional-session-")), "session.sqlite");
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = ON");
    for (const [version, name, filename] of migrations) {
      const sql = readFileSync(join(migrationDirectory, filename), "utf8");
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, sha256, app_version, applied_at) " +
        "VALUES (?, ?, ?, 'fictional-test', 100)",
      ).run(version, name, sha256(sql));
    }
    db.pragma("application_id = 1129071687");
    db.pragma("user_version = 5");
    db.prepare(
      "INSERT INTO households (singleton, id, display_name, created_at) " +
      "VALUES (1, 'fictional-family', 'Fictional family', 100)",
    ).run();
    db.prepare(
      "INSERT INTO users (id, household_id, login_name, login_name_normalized, " +
      "display_name, role, status, password_hash, created_at, updated_at, password_changed_at) " +
      "VALUES ('fictional-adult', 'fictional-family', 'adult', 'adult', " +
      "'Fictional adult', 'owner', 'active', '$argon2id$fictional', 100, 100, 100)",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, " +
      "created_at, expires_at, last_seen_at) " +
      "VALUES ('11111111-1111-4111-8111-111111111111', 'fictional-adult', ?, ?, 1, " +
      "100, 1000, 100)",
    ).run(sessionTokenSha256(token), Buffer.alloc(32, 8));
  } finally {
    db.close();
  }
  chmodSync(path, 0o600);
  return path;
}

function sha256(value: string): string {
  // Keep the fixture's migration ledger independent of production constants.
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function request(cookieValue: string): Pick<Request, "get"> {
  const get = (name: string) => name.toLowerCase() === "cookie" ? cookieValue : undefined;
  return { get } as Pick<Request, "get">;
}

describe("read-only SQLite session adapter", () => {
  it("reads the current v5 session by exact token hash without creating schema", async () => {
    const path = fictionalV5Database();
    const repository = new SqliteSessionRepository(path);
    try {
      expect((await readCookieSession(request(`${SESSION_COOKIE_NAME}=${token}`), repository, 200))?.scope)
        .toEqual({ householdId: "fictional-family", userId: "fictional-adult" });
      expect(await repository.findByTokenSha256("0".repeat(64))).toBeNull();
      expect(await readCookieSession(
        request(`${SESSION_COOKIE_NAME}=${"g".repeat(43)}`), repository, 200,
      )).toBeNull();
    } finally {
      repository.close();
    }
  });

  it("reads a fictional WAL-mode database while its writer connection remains open", async () => {
    const path = fictionalV5Database();
    const writer = new Database(path);
    writer.pragma("journal_mode = WAL");
    writer.prepare("UPDATE users SET updated_at = 101 WHERE id = 'fictional-adult'").run();
    try {
      const reader = new SqliteSessionRepository(path);
      try {
        expect((await readCookieSession(request(`${SESSION_COOKIE_NAME}=${token}`), reader, 200))?.scope)
          .toEqual({ householdId: "fictional-family", userId: "fictional-adult" });
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
  });

  it("rejects unknown versions, changed migration hashes and missing files", () => {
    const path = fictionalV5Database();
    const db = new Database(path);
    db.pragma("user_version = 6");
    db.close();
    expect(() => new SqliteSessionRepository(path)).toThrow(IncompatibleSessionDatabase);
    const cleanPath = fictionalV5Database();
    const other = new Database(cleanPath);
    other.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1")
      .run("0".repeat(64));
    other.close();
    expect(() => new SqliteSessionRepository(cleanPath)).toThrow(IncompatibleSessionDatabase);
    expect(() => new SqliteSessionRepository(`${cleanPath}.absent`))
      .toThrow(IncompatibleSessionDatabase);
    const publicPath = fictionalV5Database();
    chmodSync(publicPath, 0o644);
    expect(() => new SqliteSessionRepository(publicPath)).toThrow(IncompatibleSessionDatabase);
    const publicWalPath = fictionalV5Database();
    writeFileSync(`${publicWalPath}-wal`, "fictional", { mode: 0o644 });
    expect(() => new SqliteSessionRepository(publicWalPath)).toThrow(IncompatibleSessionDatabase);
    const invalidPath = join(mkdtempSync(join(tmpdir(), "adeno-fictional-invalid-")), "bad.sqlite");
    writeFileSync(invalidPath, "fictional invalid SQLite header", { mode: 0o600 });
    expect(() => new SqliteSessionRepository(invalidPath)).toThrow(IncompatibleSessionDatabase);
  });
});
