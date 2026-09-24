import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { type MutationPreflight, type StoredSession, verifyStoredMutationSession } from "../auth/cookieSession.js";
import { parseISODate } from "../timeline/history.js";
import { IncompatibleFamilyTimelineDatabase, privateFile, verifySchema } from "./sqliteFamilyTimeline.js";

type SessionRow = {
  sessionId: string; householdId: string; userId: string;
  userStatus: StoredSession["userStatus"]; sessionAuthVersion: number;
  userAuthVersion: number; expiresAt: number; revokedAt: number | null; csrfSecret: Buffer;
};
type ActorRow = { role: "owner" | "caregiver"; memberKind: "adult" | "child" };
type SubjectRow = { memberKind: "adult" | "child" };
type CountRow = { nextEventNo: number };
type AuditRow = { event_hash: string };

export type GrantResult =
  | { ok: true; eventId: string; eventNo: number }
  | { ok: false; status: 401 | 403 | 404; error: "AUTH_REQUIRED" | "INVALID_CSRF" | "FORBIDDEN" | "NOT_FOUND" };

/**
 * A separate, opt-in writer for an already-migrated trusted local v7 database.
 * It must never run alongside the Python service as another application writer.
 * Each mutation starts BEGIN IMMEDIATE, reloads the session and permissions,
 * performs the write and appends the v1-compatible audit event before commit.
 */
export class SqliteFamilyMutations {
  private readonly db: Database.Database;

  constructor(path: string) {
    privateFile(path, true);
    privateFile(`${path}-wal`, false);
    privateFile(`${path}-shm`, false);
    let db: Database.Database;
    try {
      db = new Database(path, { fileMustExist: true, timeout: 5_000 });
      db.pragma("foreign_keys = ON");
      db.pragma("trusted_schema = ON");
      verifySchema(db);
    } catch {
      if (db!) db.close();
      throw new IncompatibleFamilyTimelineDatabase();
    }
    this.db = db;
  }

  close(): void { this.db.close(); }

  grantDayAccess(input: {
    preflight: Extract<MutationPreflight, { ok: true }>;
    careProfileId: string; careDay: string; subjectUserId: string;
    level: "none" | "view" | "contribute" | "publish";
    reason?: string;
    nowSeconds?: number;
  }): GrantResult {
    parseISODate(input.careDay);
    if (input.reason !== undefined && (input.reason.trim().length < 1 || input.reason.length > 1000))
      throw new RangeError("Invalid grant reason");
    return this.db.transaction((): GrantResult => {
      const auth = this.authorizeOwner(input.preflight, input.careProfileId, input.nowSeconds);
      if (!auth.ok) return auth;
      const subject = this.db.prepare<[string, string], SubjectRow>(
        "SELECT member_kind memberKind FROM users WHERE id = ? AND household_id = ? AND status = 'active'",
      ).get(input.subjectUserId, auth.householdId);
      if (!subject) return { ok: false, status: 404, error: "NOT_FOUND" };
      if (input.level === "publish" && subject.memberKind !== "adult")
        return { ok: false, status: 403, error: "FORBIDDEN" };
      const eventId = randomUUID();
      const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
      const next = this.db.prepare<[string, string, string], CountRow>(
        "SELECT COALESCE(max(event_no), 0) + 1 nextEventNo FROM day_access_events " +
        "WHERE care_profile_id = ? AND care_day = ? AND subject_user_id = ?",
      ).get(input.careProfileId, input.careDay, input.subjectUserId)?.nextEventNo ?? 1;
      this.db.prepare(
        "INSERT INTO day_access_events (id, care_profile_id, care_day, subject_user_id, " +
        "event_no, level, actor_user_id, occurred_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(eventId, input.careProfileId, input.careDay, input.subjectUserId,
        next, input.level, auth.userId, now, input.reason ?? null);
      this.audit(auth.householdId, auth.userId, "day_access_changed", "day_access_event", eventId, now);
      return { ok: true, eventId, eventNo: next };
    }).immediate();
  }

  private authorizeOwner(preflight: Extract<MutationPreflight, { ok: true }>,
    careProfileId: string, nowSeconds?: number):
    | { ok: true; userId: string; householdId: string }
    | Extract<GrantResult, { ok: false }> {
    const row = this.db.prepare<[string], SessionRow>(
      "SELECT s.id sessionId, u.household_id householdId, u.id userId, u.status userStatus, " +
      "s.auth_version sessionAuthVersion, u.auth_version userAuthVersion, " +
      "s.expires_at expiresAt, s.revoked_at revokedAt, s.csrf_secret csrfSecret " +
      "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_sha256 = ?",
    ).get(preflight.tokenSha256);
    const decision = verifyStoredMutationSession(row ?? null, preflight.csrfToken, nowSeconds);
    if (!decision.ok) return decision;
    const actor = this.db.prepare<[string], ActorRow>(
      "SELECT role, member_kind memberKind FROM users WHERE id = ? AND status = 'active'",
    ).get(decision.session.scope.userId);
    if (actor?.role !== "owner" || actor.memberKind !== "adult")
      return { ok: false, status: 403, error: "FORBIDDEN" };
    const profile = this.db.prepare<[string, string], { id: string }>(
      "SELECT id FROM care_profiles WHERE id = ? AND household_id = ? AND archived_at IS NULL",
    ).get(careProfileId, decision.session.scope.householdId);
    if (!profile) return { ok: false, status: 404, error: "NOT_FOUND" };
    return { ok: true, userId: decision.session.scope.userId,
      householdId: decision.session.scope.householdId };
  }

  private audit(householdId: string, userId: string, action: string,
    entityKind: string, entityId: string, occurredAt: number): void {
    const previousHash = this.db.prepare<[], AuditRow>(
      "SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
    ).get()?.event_hash ?? null;
    const eventId = randomUUID();
    // Python's event_hash_v1 sorts these exact field names and uses compact JSON.
    const canonical = JSON.stringify({
      action, actor_user_id: userId, entity_id: entityId, entity_kind: entityKind,
      household_id: householdId, id: eventId, occurred_at: occurredAt,
      outcome: "success", previous_hash: previousHash,
    });
    const eventHash = createHash("sha256").update(canonical).digest("hex");
    this.db.prepare(
      "INSERT INTO audit_events (id, household_id, actor_user_id, action, entity_kind, " +
      "entity_id, outcome, occurred_at, previous_hash, event_hash) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?)",
    ).run(eventId, householdId, userId, action, entityKind, entityId,
      occurredAt, previousHash, eventHash);
  }
}
