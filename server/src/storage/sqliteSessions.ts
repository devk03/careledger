import { lstatSync } from "node:fs";

import Database from "better-sqlite3";

import type { SessionRepository, StoredSession } from "../auth/cookieSession.js";

const APPLICATION_ID = 1_129_071_687; // Existing Python schema: ASCII "CLDG".
const READABLE_SCHEMA_VERSION = 5;
const EXPECTED_MIGRATIONS = [
  [1, "initial", "793dbf7dc872fe52f05e2f7e9294145898ea4f1f499816d304dd8e8b8190c501"],
  [2, "cross_scope_guards", "e34ecf2c5ecebe413dd20b8d2f2a8e3e69e6d8200e39e015435089e9a9f302bd"],
  [3, "extraction_job_uniqueness", "8c86c1661b26b52704ee3b4e27d0069c67b3704ef6175196572e342d208cb1a0"],
  [4, "workflow_actor_guards", "7ed78fafba2a346cdf5caf1d706b17015ce437b0bc358e963659b075344d2378"],
  [5, "managed_e2ee_sync", "14c4ec55e77fd721386500000f122c1d21cad740e5205a622429fe4a118fd5be"],
] as const;

type MigrationRow = { version: number; name: string; sha256: string };
type SessionRow = {
  sessionId: string;
  householdId: string;
  userId: string;
  userStatus: StoredSession["userStatus"];
  sessionAuthVersion: number;
  userAuthVersion: number;
  expiresAt: number;
  revokedAt: number | null;
  csrfSecret: Buffer;
};

export class IncompatibleSessionDatabase extends Error {
  constructor() {
    super("Session database schema is unavailable or incompatible");
  }
}

/**
 * Opens only a pre-existing, trusted v5 SQLite database. This adapter never
 * migrates or writes. It does not authorize clinical data or support v6/v7.
 */
export class SqliteSessionRepository implements SessionRepository {
  private readonly database: Database.Database;
  private readonly findSession: Database.Statement<[string], SessionRow>;

  constructor(path: string) {
    assertPrivateFile(path, true);
    assertPrivateFile(`${path}-wal`, false);
    assertPrivateFile(`${path}-shm`, false);
    let database: Database.Database;
    try {
      database = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
    } catch {
      throw new IncompatibleSessionDatabase();
    }
    try {
      database.pragma("foreign_keys = ON");
      database.pragma("query_only = ON");
      database.pragma("trusted_schema = ON"); // Existing v5 JSON checks require this.
      verifySchema(database);
      this.findSession = database.prepare<[string], SessionRow>(
        "SELECT sessions.id AS sessionId, users.household_id AS householdId, " +
        "users.id AS userId, users.status AS userStatus, " +
        "sessions.auth_version AS sessionAuthVersion, " +
        "users.auth_version AS userAuthVersion, sessions.expires_at AS expiresAt, " +
        "sessions.revoked_at AS revokedAt, sessions.csrf_secret AS csrfSecret " +
        "FROM sessions JOIN users ON users.id = sessions.user_id " +
        "WHERE sessions.token_sha256 = ?",
      );
    } catch {
      database.close();
      throw new IncompatibleSessionDatabase();
    }
    this.database = database;
  }

  async findByTokenSha256(tokenSha256: string): Promise<StoredSession | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenSha256)) return null;
    const row = this.findSession.get(tokenSha256);
    if (row === undefined || !Buffer.isBuffer(row.csrfSecret)) return null;
    return {
      sessionId: row.sessionId,
      householdId: row.householdId,
      userId: row.userId,
      userStatus: row.userStatus,
      sessionAuthVersion: row.sessionAuthVersion,
      userAuthVersion: row.userAuthVersion,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      csrfSecret: row.csrfSecret,
    };
  }

  close(): void {
    this.database.close();
  }
}

function assertPrivateFile(path: string, required: boolean): void {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw new IncompatibleSessionDatabase();
    }
  } catch (error) {
    if (!required && typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT") return;
    throw new IncompatibleSessionDatabase();
  }
}

function verifySchema(database: Database.Database): void {
  const applicationId = database.pragma("application_id", { simple: true });
  const userVersion = database.pragma("user_version", { simple: true });
  if (applicationId !== APPLICATION_ID || userVersion !== READABLE_SCHEMA_VERSION) {
    throw new IncompatibleSessionDatabase();
  }
  const rows = database.prepare<[], MigrationRow>(
    "SELECT version, name, sha256 FROM schema_migrations ORDER BY version",
  ).all();
  if (rows.length !== EXPECTED_MIGRATIONS.length ||
    rows.some((row, index) => {
      const expected = EXPECTED_MIGRATIONS[index];
      return expected === undefined || row.version !== expected[0] ||
        row.name !== expected[1] || row.sha256 !== expected[2];
    })) {
    throw new IncompatibleSessionDatabase();
  }
  const integrity = database.prepare<[], { integrity_check: string }>("PRAGMA integrity_check").get();
  const invalidForeignKey = database.prepare("PRAGMA foreign_key_check").get();
  if (integrity?.integrity_check !== "ok" || invalidForeignKey !== undefined) {
    throw new IncompatibleSessionDatabase();
  }
}
