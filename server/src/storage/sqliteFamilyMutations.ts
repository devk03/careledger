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
type AuthorizedActor = { ok: true; userId: string; householdId: string;
  role: "owner" | "caregiver"; memberKind: "adult" | "child" };

export type GrantResult =
  | { ok: true; eventId: string; eventNo: number }
  | { ok: false; status: 401 | 403 | 404; error: "AUTH_REQUIRED" | "INVALID_CSRF" | "FORBIDDEN" | "NOT_FOUND" };
export type NoteProposalResult =
  | { ok: true; noteId: string; revisionId: string; reviewRequestId: string | null }
  | Extract<GrantResult, { ok: false }>;
export type NoteReviewResult =
  | { ok: true; snapshotId: string | null; revision: number }
  | { ok: false; status: 401 | 403 | 404 | 409;
      error: "AUTH_REQUIRED" | "INVALID_CSRF" | "FORBIDDEN" | "NOT_FOUND" | "STALE_REVISION" };

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

  grantDocumentAccess(input: {
    preflight: Extract<MutationPreflight, { ok: true }>;
    careProfileId: string; documentId: string; subjectUserId: string;
    allowed: boolean; nowSeconds?: number;
  }): GrantResult {
    return this.db.transaction((): GrantResult => {
      const auth = this.authorizeOwner(input.preflight, input.careProfileId, input.nowSeconds);
      if (!auth.ok) return auth;
      const subject = this.db.prepare<[string, string], SubjectRow>(
        "SELECT member_kind memberKind FROM users WHERE id = ? AND household_id = ? AND status = 'active'",
      ).get(input.subjectUserId, auth.householdId);
      const document = this.db.prepare<[string, string], { id: string }>(
        "SELECT id FROM documents WHERE id = ? AND care_profile_id = ? AND archived_at IS NULL",
      ).get(input.documentId, input.careProfileId);
      if (!subject || !document) return { ok: false, status: 404, error: "NOT_FOUND" };
      const eventId = randomUUID();
      const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
      const next = this.db.prepare<[string, string], CountRow>(
        "SELECT COALESCE(max(event_no), 0) + 1 nextEventNo FROM document_access_events " +
        "WHERE document_id = ? AND subject_user_id = ?",
      ).get(input.documentId, input.subjectUserId)?.nextEventNo ?? 1;
      this.db.prepare("INSERT INTO document_access_events (id, care_profile_id, document_id, " +
        "subject_user_id, event_no, allowed, actor_user_id, occurred_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(eventId, input.careProfileId, input.documentId, input.subjectUserId,
          next, input.allowed ? 1 : 0, auth.userId, now);
      this.audit(auth.householdId, auth.userId,
        "document_access_changed", "document_access_event", eventId, now);
      return { ok: true, eventId, eventNo: next };
    }).immediate();
  }

  grantProfileIntake(input: {
    preflight: Extract<MutationPreflight, { ok: true }>;
    careProfileId: string; subjectUserId: string; allowed: boolean; nowSeconds?: number;
  }): GrantResult {
    return this.db.transaction((): GrantResult => {
      const auth = this.authorizeOwner(input.preflight, input.careProfileId, input.nowSeconds);
      if (!auth.ok) return auth;
      const subject = this.db.prepare<[string, string], SubjectRow>(
        "SELECT member_kind memberKind FROM users WHERE id = ? AND household_id = ? AND status = 'active'",
      ).get(input.subjectUserId, auth.householdId);
      if (!subject) return { ok: false, status: 404, error: "NOT_FOUND" };
      const eventId = randomUUID();
      const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
      const next = this.db.prepare<[string, string], CountRow>(
        "SELECT COALESCE(max(event_no), 0) + 1 nextEventNo FROM profile_intake_events " +
        "WHERE care_profile_id = ? AND subject_user_id = ?",
      ).get(input.careProfileId, input.subjectUserId)?.nextEventNo ?? 1;
      this.db.prepare("INSERT INTO profile_intake_events (id, care_profile_id, " +
        "subject_user_id, event_no, allowed, actor_user_id, occurred_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(eventId, input.careProfileId, input.subjectUserId,
          next, input.allowed ? 1 : 0, auth.userId, now);
      this.audit(auth.householdId, auth.userId,
        "profile_intake_changed", "profile_intake_event", eventId, now);
      return { ok: true, eventId, eventNo: next };
    }).immediate();
  }

  proposeNote(input: {
    preflight: Extract<MutationPreflight, { ok: true }>;
    careProfileId: string; careDay: string; body: string; nowSeconds?: number;
  }): NoteProposalResult {
    parseISODate(input.careDay);
    if (input.body.trim().length < 1 || input.body.length > 10_000)
      throw new RangeError("Invalid note body");
    return this.db.transaction((): NoteProposalResult => {
      const actor = this.authorizeActor(input.preflight, input.careProfileId, input.nowSeconds);
      if (!actor.ok) return actor;
      const intake = this.db.prepare<[string, string]>(
        "SELECT 1 FROM current_profile_intake WHERE care_profile_id = ? AND subject_user_id = ?",
      ).get(input.careProfileId, actor.userId);
      if (actor.role !== "owner" && !intake)
        return { ok: false, status: 403, error: "FORBIDDEN" };
      const noteId = randomUUID();
      const revisionId = randomUUID();
      const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
      this.db.prepare("INSERT INTO family_notes (id, care_profile_id, created_by, created_at) " +
        "VALUES (?, ?, ?, ?)").run(noteId, input.careProfileId, actor.userId, now);
      this.db.prepare("INSERT INTO family_note_revisions (id, note_id, revision_no, care_day, " +
        "body, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)")
        .run(revisionId, noteId, input.careDay, input.body.trim(), actor.userId, now);
      let reviewRequestId: string | null = null;
      if (actor.memberKind === "child") {
        reviewRequestId = randomUUID();
        this.db.prepare("INSERT INTO child_review_requests (id, care_profile_id, target_care_day, " +
          "proposed_by, note_revision_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(reviewRequestId, input.careProfileId, input.careDay, actor.userId, revisionId, now);
      }
      this.audit(actor.householdId, actor.userId, "family_note_proposed",
        "family_note_revision", revisionId, now);
      return { ok: true, noteId, revisionId, reviewRequestId };
    }).immediate();
  }

  reviewNote(input: {
    preflight: Extract<MutationPreflight, { ok: true }>;
    careProfileId: string; revisionId: string; expectedDayRevision: number;
    decision: "accepted" | "rejected"; reason?: string; nowSeconds?: number;
  }): NoteReviewResult {
    if (!Number.isSafeInteger(input.expectedDayRevision) || input.expectedDayRevision < 0 ||
      (input.reason !== undefined &&
        (input.reason.trim().length < 1 || input.reason.length > 2000)))
      throw new RangeError("Invalid review input");
    return this.db.transaction((): NoteReviewResult => {
      const actor = this.authorizeActor(input.preflight, input.careProfileId, input.nowSeconds);
      if (!actor.ok) return actor;
      if (actor.memberKind !== "adult")
        return { ok: false, status: 403, error: "FORBIDDEN" };
      const note = this.db.prepare<[string, string], { careDay: string }>(
        "SELECT r.care_day careDay FROM family_note_revisions r " +
        "JOIN family_notes n ON n.id = r.note_id WHERE r.id = ? AND n.care_profile_id = ? " +
        "AND r.care_day IS NOT NULL AND NOT EXISTS " +
        "(SELECT 1 FROM family_note_reviews rev WHERE rev.revision_id = r.id)",
      ).get(input.revisionId, input.careProfileId);
      if (!note) return { ok: false, status: 404, error: "NOT_FOUND" };
      const canPublish = actor.role === "owner" || this.db.prepare<[string, string, string]>(
        "SELECT 1 FROM current_day_access WHERE care_profile_id = ? AND care_day = ? " +
        "AND subject_user_id = ? AND level = 'publish'",
      ).get(input.careProfileId, note.careDay, actor.userId) !== undefined;
      if (!canPublish) return { ok: false, status: 403, error: "FORBIDDEN" };
      const latest = this.db.prepare<[string, string], { dayNodeId: string; snapshotId: string;
        revision: number }>(
        "SELECT n.id dayNodeId, s.id snapshotId, s.revision_no revision FROM day_nodes n " +
        "JOIN day_snapshots s ON s.day_node_id = n.id AND s.revision_no = " +
        "(SELECT max(revision_no) FROM day_snapshots WHERE day_node_id = n.id) " +
        "WHERE n.care_profile_id = ? AND n.care_day = ?",
      ).get(input.careProfileId, note.careDay);
      const currentRevision = latest?.revision ?? 0;
      if (input.expectedDayRevision !== currentRevision)
        return { ok: false, status: 409, error: "STALE_REVISION" };
      const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
      this.db.prepare("INSERT INTO family_note_reviews (id, revision_id, decision, " +
        "reviewer_id, decided_at, reason) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), input.revisionId, input.decision, actor.userId, now, input.reason ?? null);
      let snapshotId: string | null = null;
      let revision = currentRevision;
      if (input.decision === "accepted") {
        const dayNodeId = latest?.dayNodeId ?? randomUUID();
        if (!latest) this.db.prepare("INSERT INTO day_nodes (id, care_profile_id, care_day, " +
          "created_by, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(dayNodeId, input.careProfileId, note.careDay, actor.userId, now);
        const entries = this.publishedEntries(input.careProfileId, note.careDay);
        snapshotId = randomUUID();
        revision = currentRevision + 1;
        const contentHash = createHash("sha256")
          .update(JSON.stringify(entries)).digest("hex");
        this.db.prepare("INSERT INTO day_snapshots (id, day_node_id, revision_no, " +
          "previous_snapshot_id, content_sha256, published_by, published_at, reason) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(snapshotId, dayNodeId, revision, latest?.snapshotId ?? null,
            contentHash, actor.userId, now, input.reason ?? null);
        const insertEntry = this.db.prepare("INSERT INTO day_snapshot_entries " +
          "(snapshot_id, position, placement_revision_id, note_revision_id, claim_revision_id) " +
          "VALUES (?, ?, ?, ?, ?)");
        for (const [position, entry] of entries.entries()) {
          insertEntry.run(snapshotId, position,
            entry.kind === "placement" ? entry.id : null,
            entry.kind === "note" ? entry.id : null,
            entry.kind === "claim" ? entry.id : null);
        }
      }
      this.audit(actor.householdId, actor.userId,
        input.decision === "accepted" ? "family_note_published" : "family_note_rejected",
        "family_note_revision", input.revisionId, now);
      return { ok: true, snapshotId, revision };
    }).immediate();
  }

  private publishedEntries(careProfileId: string, careDay: string):
    { kind: "placement" | "note" | "claim"; id: string }[] {
    const placements = this.db.prepare<[string, string], { id: string }>(
      "SELECT revision_id id FROM current_accepted_document_days " +
      "WHERE care_profile_id = ? AND care_day = ? ORDER BY placement_id",
    ).all(careProfileId, careDay).map((row) => ({ kind: "placement" as const, id: row.id }));
    const notes = this.db.prepare<[string, string], { id: string }>(
      "SELECT revision_id id FROM current_accepted_family_notes " +
      "WHERE care_profile_id = ? AND care_day = ? ORDER BY created_at, note_id",
    ).all(careProfileId, careDay).map((row) => ({ kind: "note" as const, id: row.id }));
    const claims = this.db.prepare<[string, string], { id: string }>(
      "SELECT r.id FROM current_evidence_claim_revisions r " +
      "JOIN evidence_claims c ON c.id = r.claim_id WHERE c.care_profile_id = ? " +
      "AND r.event_date = ? AND r.review_state = 'accepted' ORDER BY r.claim_id",
    ).all(careProfileId, careDay).map((row) => ({ kind: "claim" as const, id: row.id }));
    return [...placements, ...notes, ...claims];
  }

  private authorizeOwner(preflight: Extract<MutationPreflight, { ok: true }>,
    careProfileId: string, nowSeconds?: number):
    | { ok: true; userId: string; householdId: string }
    | Extract<GrantResult, { ok: false }> {
    const actor = this.authorizeActor(preflight, careProfileId, nowSeconds);
    if (!actor.ok) return actor;
    if (actor.role !== "owner" || actor.memberKind !== "adult")
      return { ok: false, status: 403, error: "FORBIDDEN" };
    return { ok: true, userId: actor.userId, householdId: actor.householdId };
  }

  private authorizeActor(preflight: Extract<MutationPreflight, { ok: true }>,
    careProfileId: string, nowSeconds?: number): AuthorizedActor | Extract<GrantResult, { ok: false }> {
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
    if (!actor) return { ok: false, status: 401, error: "AUTH_REQUIRED" };
    const profile = this.db.prepare<[string, string], { id: string }>(
      "SELECT id FROM care_profiles WHERE id = ? AND household_id = ? AND archived_at IS NULL",
    ).get(careProfileId, decision.session.scope.householdId);
    if (!profile) return { ok: false, status: 404, error: "NOT_FOUND" };
    return { ok: true, userId: decision.session.scope.userId,
      householdId: decision.session.scope.householdId,
      role: actor.role, memberKind: actor.memberKind };
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
