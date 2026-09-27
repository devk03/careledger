import type Database from "better-sqlite3";

import { assertManagedSchema } from "./managedSchemaGuard.js";

export class ManagedSignupPreflightDenied extends Error {
  constructor() {
    super("Proof-first managed signup cannot start from this database.");
  }
}

/**
 * Read-only preflight for a future proof-first signup service. V10 pending or
 * otherwise unverified accounts already reserve immutable unique emails.
 * A frozen family without an active verified owner may be an abandoned signup.
 * Do not infer that this preflight alone makes v11 safe: run it behind a writer
 * fence, recheck in the activation transaction, and keep legacy callers off.
 */
export function assertProofFirstSignupLegacyState(db: Database.Database): void {
  try {
    assertManagedSchema(db);
    const databases = db.prepare<[], { name: string; file: string }>(
      "PRAGMA database_list").all();
    if (databases.length < 1 || databases.length > 2 ||
      databases[0]?.name !== "main" ||
      databases.slice(1).some((row) => row.name !== "temp" || row.file !== "") ||
      db.prepare<[], { n: number }>(
        "SELECT count(*) AS n FROM sqlite_temp_master").get()?.n !== 0)
      throw new ManagedSignupPreflightDenied();
    const state = db.prepare<[], { unverifiedAccount: number;
      frozenWithoutVerifiedOwner: number }>(
      "SELECT EXISTS (SELECT 1 FROM main.managed_accounts a " +
      "WHERE a.state='pending' OR a.email_verified_at IS NULL) " +
      "AS unverifiedAccount, " +
      "EXISTS (SELECT 1 FROM main.managed_families f " +
      "WHERE f.state='frozen' AND NOT EXISTS (" +
      "SELECT 1 FROM main.managed_memberships m " +
      "JOIN main.managed_accounts a ON a.id=m.account_id " +
      "WHERE m.household_id=f.id AND m.role='owner' " +
      "AND m.state='active' AND a.state='active' " +
      "AND a.email_verified_at IS NOT NULL)) " +
      "AS frozenWithoutVerifiedOwner",
    ).get();
    if (!state || state.unverifiedAccount !== 0 ||
      state.frozenWithoutVerifiedOwner !== 0)
      throw new ManagedSignupPreflightDenied();
  } catch { throw new ManagedSignupPreflightDenied(); }
}
