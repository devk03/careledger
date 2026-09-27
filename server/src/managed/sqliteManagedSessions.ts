import type Database from "better-sqlite3";

import type { SessionRepository, StoredSession } from
  "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";

const SHA256 = /^[0-9a-f]{64}$/u;

type Row = {
  sessionId: string;
  householdId: string;
  userId: string;
  expiresAt: number;
  revokedAt: number | null;
  csrfSecret: Buffer;
  sessionAuthVersion: number;
  userAuthVersion: number;
};

/**
 * Read-only managed-v10 cookie session adapter. It never accepts an account,
 * device or household ID from the request body. This is not a login service;
 * uploads must independently recheck authority inside their write transaction.
 */
export class SqliteManagedSessions implements SessionRepository {
  constructor(private readonly db: Database.Database) {
    assertManagedSchema(db);
  }

  async findByTokenSha256(tokenSha256: string): Promise<StoredSession | null> {
    try {
      if (typeof tokenSha256 !== "string" || !SHA256.test(tokenSha256))
        return null;
      const read = this.db.transaction((): StoredSession | null => {
        assertManagedSchema(this.db);
        const row = this.db.prepare<[Buffer], Row>(
          "SELECT s.id AS sessionId, s.household_id AS householdId, " +
          "s.account_id AS userId, s.expires_at AS expiresAt, " +
          "s.revoked_at AS revokedAt, s.csrf_secret AS csrfSecret, " +
          "s.account_auth_version AS sessionAuthVersion, " +
          "a.auth_version AS userAuthVersion " +
          "FROM managed_sessions s " +
          "JOIN managed_accounts a ON a.id=s.account_id " +
          "JOIN managed_memberships m ON m.household_id=s.household_id " +
          "AND m.account_id=s.account_id " +
          "JOIN managed_families f ON f.id=s.household_id " +
          "WHERE s.token_sha256=? AND s.revoked_at IS NULL " +
          "AND s.expires_at>unixepoch('now') " +
          "AND s.account_auth_version=a.auth_version " +
          "AND s.membership_auth_version=m.auth_version " +
          "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
          "AND m.state='active' AND f.state='active'",
        ).get(Buffer.from(tokenSha256, "hex"));
        if (!row || !Buffer.isBuffer(row.csrfSecret) ||
          row.csrfSecret.byteLength !== 32 ||
          !Number.isSafeInteger(row.expiresAt) ||
          !Number.isSafeInteger(row.sessionAuthVersion) ||
          !Number.isSafeInteger(row.userAuthVersion)) return null;
        return { sessionId: row.sessionId, householdId: row.householdId,
          userId: row.userId, userStatus: "active",
          sessionAuthVersion: row.sessionAuthVersion,
          userAuthVersion: row.userAuthVersion,
          expiresAt: row.expiresAt, revokedAt: row.revokedAt,
          csrfSecret: Buffer.from(row.csrfSecret) };
      });
      return read.deferred();
    } catch { return null; }
  }
}
