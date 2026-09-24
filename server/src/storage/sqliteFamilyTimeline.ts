import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";

import Database from "better-sqlite3";

import type { ApprovedPageRepository, CareProfileRepository, DayVersion, DayVersionRepository, ISODate,
  PendingNoteHint, PendingReviewHint, PendingReviewRepository,
  StoredPageChunk, TimelineDay, TimelineRepository, VisibleCareProfile } from "../timeline/types.js";
import type { SessionRepository, StoredSession } from "../auth/cookieSession.js";

const MIGRATIONS = [
  [1, "initial", "793dbf7dc872fe52f05e2f7e9294145898ea4f1f499816d304dd8e8b8190c501"],
  [2, "cross_scope_guards", "e34ecf2c5ecebe413dd20b8d2f2a8e3e69e6d8200e39e015435089e9a9f302bd"],
  [3, "extraction_job_uniqueness", "8c86c1661b26b52704ee3b4e27d0069c67b3704ef6175196572e342d208cb1a0"],
  [4, "workflow_actor_guards", "7ed78fafba2a346cdf5caf1d706b17015ce437b0bc358e963659b075344d2378"],
  [5, "managed_e2ee_sync", "14c4ec55e77fd721386500000f122c1d21cad740e5205a622429fe4a118fd5be"],
  [6, "sparse_care_days", "faa0e162b458861ac40efda0ca90ddf847ed5c19a79455e699053d932ac6cefb"],
  [7, "family_day_access", "9c7233be9238bd7fc6ad08b92881737accb17057fe7486a2192a2168051cc947"],
] as const;

type MigrationRow = { version: number; name: string; sha256: string };
type DayRow = { id: string; day: ISODate; revision: number; snapshotId: string };
type EntryRow = {
  placementRevisionId: string | null;
  noteRevisionId: string | null;
  claimRevisionId: string | null;
};
type DocumentRow = {
  documentId: string; displayName: string; uploadedAt: number; sourceSha256: string; pageNumber: number | null;
};
type StatementRow = { id: string; text: string; authorLabel: string | null };
type PageRow = { sourceSha256: string; text: string; textSha256: string };
type SessionRow = {
  sessionId: string; householdId: string; userId: string;
  userStatus: StoredSession["userStatus"]; sessionAuthVersion: number;
  userAuthVersion: number; expiresAt: number; revokedAt: number | null; csrfSecret: Buffer;
};

export class IncompatibleFamilyTimelineDatabase extends Error {
  constructor() { super("Family timeline database is unavailable or incompatible"); }
}

/**
 * Read-only adapter for an explicitly migrated, trusted local v7 database.
 * Never use this plaintext schema for hosted family-controlled E2EE storage.
 * The database is opened afresh as a read-only connection; all clinical reads
 * recheck user status and current grants, including after MCP connection setup.
 */
export class SqliteFamilyTimeline implements TimelineRepository, ApprovedPageRepository,
  PendingReviewRepository, DayVersionRepository, CareProfileRepository, SessionRepository {
  private readonly db: Database.Database;

  constructor(path: string) {
    privateFile(path, true);
    privateFile(`${path}-wal`, false);
    privateFile(`${path}-shm`, false);
    let db: Database.Database;
    try {
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5_000 });
      db.pragma("foreign_keys = ON");
      db.pragma("query_only = ON");
      db.pragma("trusted_schema = ON"); // Existing JSON constraints require this.
      verifySchema(db);
    } catch {
      if (db!) db.close();
      throw new IncompatibleFamilyTimelineDatabase();
    }
    this.db = db;
  }

  close(): void { this.db.close(); }

  ready(): boolean {
    try { verifySchema(this.db); return true; }
    catch { return false; }
  }

  async findByTokenSha256(tokenSha256: string): Promise<StoredSession | null> {
    if (!/^[0-9a-f]{64}$/.test(tokenSha256)) return null;
    const row = this.db.prepare<[string], SessionRow>(
      "SELECT s.id sessionId, u.household_id householdId, u.id userId, u.status userStatus, " +
      "s.auth_version sessionAuthVersion, u.auth_version userAuthVersion, s.expires_at expiresAt, " +
      "s.revoked_at revokedAt, s.csrf_secret csrfSecret FROM sessions s " +
      "JOIN users u ON u.id = s.user_id WHERE s.token_sha256 = ?",
    ).get(tokenSha256);
    if (!row || !Buffer.isBuffer(row.csrfSecret)) return null;
    return row;
  }

  async profileBelongsToHousehold(careProfileId: string, householdId: string): Promise<boolean> {
    return this.db.prepare<[string, string], { ok: number }>(
      "SELECT 1 ok FROM care_profiles WHERE id = ? AND household_id = ? AND archived_at IS NULL",
    ).get(careProfileId, householdId) !== undefined;
  }

  async listVisibleCareProfiles(input: { householdId: string; userId: string }):
    Promise<VisibleCareProfile[]> {
    return this.db.prepare<[string, string], { id: string; preferredName: string }>(
      "SELECT p.id, p.preferred_name preferredName FROM care_profiles p " +
      "JOIN users u ON u.id = ? AND u.household_id = p.household_id AND u.status = 'active' " +
      "WHERE p.household_id = ? AND p.archived_at IS NULL " +
      "AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM current_day_access a " +
      "WHERE a.care_profile_id = p.id AND a.subject_user_id = u.id) " +
      "OR EXISTS (SELECT 1 FROM current_document_access a " +
      "WHERE a.care_profile_id = p.id AND a.subject_user_id = u.id) " +
      "OR EXISTS (SELECT 1 FROM current_profile_intake a " +
      "WHERE a.care_profile_id = p.id AND a.subject_user_id = u.id)) " +
      "ORDER BY p.preferred_name, p.id",
    ).all(input.userId, input.householdId);
  }

  async listApprovedDays(input: {
    householdId: string; userId: string; careProfileId: string;
    throughDay: ISODate; beforeDay?: ISODate; limit: number;
  }): Promise<TimelineDay[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 51) return [];
    return this.db.transaction(() => this.listApprovedDaysInReadTransaction(input)).deferred();
  }

  private listApprovedDaysInReadTransaction(input: {
    householdId: string; userId: string; careProfileId: string;
    throughDay: ISODate; beforeDay?: ISODate; limit: number;
  }): TimelineDay[] {
    const rows = this.db.prepare<[
      string, string, string, string, string, number
    ], DayRow>(
      "SELECT n.id, n.care_day day, s.revision_no revision, s.id snapshotId " +
      "FROM day_nodes n JOIN care_profiles p ON p.id = n.care_profile_id " +
      "JOIN users u ON u.id = ? AND u.household_id = p.household_id AND u.status = 'active' " +
      "JOIN day_snapshots s ON s.day_node_id = n.id AND s.revision_no = " +
      "(SELECT max(revision_no) FROM day_snapshots WHERE day_node_id = n.id) " +
      "WHERE p.household_id = ? AND p.id = ? AND p.archived_at IS NULL " +
      "AND n.care_day <= ? AND n.care_day < ? " +
      "AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM current_day_access a " +
      "WHERE a.care_profile_id = n.care_profile_id AND a.care_day = n.care_day " +
      "AND a.subject_user_id = u.id)) ORDER BY n.care_day DESC LIMIT ?",
    ).all(input.userId, input.householdId, input.careProfileId,
      input.throughDay, input.beforeDay ?? "9999-12-31", input.limit);
    return rows.map((row) => this.readDay(row, input));
  }

  private readDay(row: DayRow, input: { householdId: string; userId: string; careProfileId: string }): TimelineDay {
    const entries = this.db.prepare<[string], EntryRow>(
      "SELECT placement_revision_id placementRevisionId, note_revision_id noteRevisionId, " +
      "claim_revision_id claimRevisionId FROM day_snapshot_entries " +
      "WHERE snapshot_id = ? ORDER BY position",
    ).all(row.snapshotId);
    const sources = new Map<string, TimelineDay["sources"][number]>();
    const statements: TimelineDay["statements"] = [];
    for (const entry of entries) {
      if (entry.placementRevisionId) {
        const documents = this.db.prepare<[string, string, string, string], DocumentRow>(
          "SELECT d.id documentId, d.original_display_name displayName, d.uploaded_at uploadedAt, " +
          "d.source_sha256 sourceSha256, pg.page_number pageNumber " +
          "FROM document_day_placement_revisions r " +
          "JOIN document_day_placements pl ON pl.id = r.placement_id " +
          "JOIN documents d ON d.id = pl.document_id AND d.care_profile_id = pl.care_profile_id " +
          "LEFT JOIN document_pages pg ON pg.document_id = d.id " +
          "JOIN users u ON u.id = ? AND u.status = 'active' AND u.household_id = ? " +
          "WHERE r.id = ? AND pl.care_profile_id = ? AND d.archived_at IS NULL " +
          "AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM current_document_access a " +
          "WHERE a.document_id = d.id AND a.care_profile_id = pl.care_profile_id " +
          "AND a.subject_user_id = u.id)) ORDER BY pg.page_number",
        ).all(input.userId, input.householdId, entry.placementRevisionId, input.careProfileId);
        for (const document of documents) {
          const existing = sources.get(document.documentId);
          if (existing) {
            if (document.pageNumber !== null) existing.pageNumbers.push(document.pageNumber);
          } else {
            sources.set(document.documentId, {
              documentId: document.documentId, displayName: document.displayName,
              uploadedAt: new Date(document.uploadedAt * 1000).toISOString(),
              sourceSha256: document.sourceSha256,
              pageNumbers: document.pageNumber === null ? [] : [document.pageNumber],
            });
          }
        }
      } else if (entry.noteRevisionId) {
        const note = this.db.prepare<[string, string], StatementRow>(
          "SELECT r.id, r.body text, u.display_name authorLabel FROM family_note_revisions r " +
          "JOIN users u ON u.id = r.created_by JOIN family_notes n ON n.id = r.note_id " +
          "WHERE r.id = ? AND n.care_profile_id = ?",
        ).get(entry.noteRevisionId, input.careProfileId);
        if (note) statements.push({ id: note.id, text: note.text, attribution: "family_note",
          ...(note.authorLabel === null ? {} : { authorLabel: note.authorLabel }), status: "uncertain" });
      } else if (entry.claimRevisionId) {
        const claim = this.db.prepare<[string, string], StatementRow>(
          "SELECT r.id, r.statement text, NULL authorLabel FROM evidence_claim_revisions r " +
          "JOIN evidence_claims c ON c.id = r.claim_id WHERE r.id = ? AND c.care_profile_id = ? " +
          "AND r.review_state = 'accepted'",
        ).get(entry.claimRevisionId, input.careProfileId);
        if (claim) statements.push({ id: claim.id, text: claim.text, attribution: "document", status: "uncertain" });
      }
    }
    return { id: row.id, careProfileId: input.careProfileId, day: row.day,
      revision: row.revision, sources: [...sources.values()], statements };
  }

  async readApprovedPageChunk(input: {
    householdId: string; userId: string; careProfileId: string; documentId: string;
    pageNumber: number; offset: number; maxChars: number;
  }): Promise<StoredPageChunk | null> {
    if (!Number.isSafeInteger(input.offset) || !Number.isSafeInteger(input.maxChars) ||
      input.offset < 0 || input.maxChars < 1 || input.maxChars > 6_000) return null;
    const row = this.db.prepare<[string, number, string, string, string], PageRow>(
      "SELECT d.source_sha256 sourceSha256, pg.extracted_text text, pg.text_sha256 textSha256 " +
      "FROM documents d JOIN care_profiles p ON p.id = d.care_profile_id " +
      "JOIN users u ON u.id = ? AND u.status = 'active' AND u.household_id = p.household_id " +
      "JOIN document_pages pg ON pg.document_id = d.id AND pg.page_number = ? " +
      "WHERE p.household_id = ? AND p.id = ? AND p.archived_at IS NULL " +
      "AND d.id = ? AND d.archived_at IS NULL AND pg.extracted_text IS NOT NULL " +
      "AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM current_document_access a " +
      "WHERE a.care_profile_id = p.id AND a.document_id = d.id AND a.subject_user_id = u.id))",
    ).get(input.userId, input.pageNumber, input.householdId, input.careProfileId, input.documentId);
    if (!row || createHash("sha256").update(row.text).digest("hex") !== row.textSha256 ||
      input.offset >= row.text.length) return null;
    const text = row.text.slice(input.offset, input.offset + input.maxChars);
    const nextOffset = input.offset + text.length < row.text.length ? input.offset + text.length : null;
    return { documentId: input.documentId, pageNumber: input.pageNumber,
      sourceSha256: row.sourceSha256, offset: input.offset, text, nextOffset };
  }

  async listPendingChildReviews(input: {
    householdId: string; userId: string; careProfileId: string;
  }): Promise<PendingReviewHint[]> {
    const rows = this.db.prepare<[string, string, string], { id: string; revisionId: string;
      targetCareDay: string | null; createdAt: number }>(
      "SELECT request.id, COALESCE(raw.note_revision_id, raw.placement_revision_id) revisionId, " +
      "request.target_care_day targetCareDay, " +
      "request.created_at createdAt FROM pending_child_reviews request " +
      "JOIN child_review_requests raw ON raw.id = request.id " +
      "JOIN care_profiles p ON p.id = request.care_profile_id AND p.archived_at IS NULL " +
      "JOIN users reviewer ON reviewer.id = ? AND reviewer.household_id = p.household_id " +
      "AND reviewer.status = 'active' AND reviewer.member_kind = 'adult' " +
      "WHERE p.household_id = ? AND p.id = ? " +
      "AND (reviewer.role = 'owner' OR EXISTS (SELECT 1 FROM current_day_access grant_row " +
      "WHERE grant_row.care_profile_id = p.id AND grant_row.care_day = request.target_care_day " +
      "AND grant_row.subject_user_id = reviewer.id AND grant_row.level = 'publish')) " +
      "ORDER BY request.created_at, request.id LIMIT 50",
    ).all(input.userId, input.householdId, input.careProfileId);
    return rows.map((row) => ({ id: row.id, revisionId: row.revisionId,
      targetCareDay: row.targetCareDay,
      createdAt: new Date(row.createdAt * 1000).toISOString() }));
  }

  async listPendingNoteReviews(input: { householdId: string; userId: string;
    careProfileId: string }): Promise<PendingNoteHint[]> {
    const rows = this.db.prepare<[string, string, string], { revisionId: string;
      reviewRequestId: string | null; targetCareDay: string; createdAt: number }>(
      "SELECT r.id revisionId, child.id reviewRequestId, r.care_day targetCareDay, " +
      "r.created_at createdAt FROM family_note_revisions r " +
      "JOIN family_notes n ON n.id = r.note_id " +
      "JOIN care_profiles p ON p.id = n.care_profile_id AND p.archived_at IS NULL " +
      "JOIN users reviewer ON reviewer.id = ? AND reviewer.household_id = p.household_id " +
      "AND reviewer.status = 'active' AND reviewer.member_kind = 'adult' " +
      "LEFT JOIN child_review_requests child ON child.note_revision_id = r.id " +
      "WHERE p.household_id = ? AND p.id = ? AND r.care_day IS NOT NULL " +
      "AND NOT EXISTS (SELECT 1 FROM family_note_reviews reviewed WHERE reviewed.revision_id = r.id) " +
      "AND (reviewer.role = 'owner' OR EXISTS (SELECT 1 FROM current_day_access grant_row " +
      "WHERE grant_row.care_profile_id = p.id AND grant_row.care_day = r.care_day " +
      "AND grant_row.subject_user_id = reviewer.id AND grant_row.level = 'publish')) " +
      "ORDER BY r.created_at, r.id LIMIT 50",
    ).all(input.userId, input.householdId, input.careProfileId);
    return rows.map((row) => ({ revisionId: row.revisionId,
      reviewRequestId: row.reviewRequestId, targetCareDay: row.targetCareDay,
      createdAt: new Date(row.createdAt * 1000).toISOString() }));
  }

  async listDayVersions(input: { householdId: string; userId: string;
    careProfileId: string; careDay: ISODate }): Promise<DayVersion[]> {
    const rows = this.db.prepare<[string, string, string, string], { revision: number;
      publishedAt: number; publisherUserId: string; reason: string | null;
      contentSha256: string }>(
      "SELECT s.revision_no revision, s.published_at publishedAt, " +
      "s.published_by publisherUserId, s.reason, s.content_sha256 contentSha256 " +
      "FROM day_nodes n JOIN care_profiles p ON p.id = n.care_profile_id AND p.archived_at IS NULL " +
      "JOIN users u ON u.id = ? AND u.household_id = p.household_id AND u.status = 'active' " +
      "JOIN day_snapshots s ON s.day_node_id = n.id " +
      "WHERE p.household_id = ? AND p.id = ? AND n.care_day = ? " +
      "AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM current_day_access a " +
      "WHERE a.care_profile_id = p.id AND a.care_day = n.care_day AND a.subject_user_id = u.id)) " +
      "ORDER BY s.revision_no DESC",
    ).all(input.userId, input.householdId, input.careProfileId, input.careDay);
    return rows.map((row) => ({ revision: row.revision,
      publishedAt: new Date(row.publishedAt * 1000).toISOString(),
      publisherUserId: row.publisherUserId, reason: row.reason,
      contentSha256: row.contentSha256 }));
  }

  async readDayVersion(input: { householdId: string; userId: string;
    careProfileId: string; careDay: ISODate; revision: number }): Promise<TimelineDay | null> {
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) return null;
    return this.db.transaction(() => {
      const row = this.db.prepare<[string, string, string, string, number], DayRow>(
        "SELECT n.id, n.care_day day, s.revision_no revision, s.id snapshotId " +
        "FROM day_nodes n JOIN care_profiles p ON p.id = n.care_profile_id AND p.archived_at IS NULL " +
        "JOIN users u ON u.id = ? AND u.household_id = p.household_id AND u.status = 'active' " +
        "JOIN day_snapshots s ON s.day_node_id = n.id " +
        "WHERE p.household_id = ? AND p.id = ? AND n.care_day = ? AND s.revision_no = ? " +
        "AND (u.role = 'owner' OR EXISTS (SELECT 1 FROM current_day_access a " +
        "WHERE a.care_profile_id = p.id AND a.care_day = n.care_day AND a.subject_user_id = u.id))",
      ).get(input.userId, input.householdId, input.careProfileId, input.careDay, input.revision);
      return row ? this.readDay(row, input) : null;
    }).deferred();
  }
}

export function privateFile(path: string, required: boolean): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new IncompatibleFamilyTimelineDatabase();
  } catch (error) {
    if (!required && typeof error === "object" && error !== null &&
      "code" in error && error.code === "ENOENT") return;
    throw new IncompatibleFamilyTimelineDatabase();
  }
}

export function verifySchema(db: Database.Database): void {
  if (db.pragma("application_id", { simple: true }) !== 1_129_071_687 ||
    db.pragma("user_version", { simple: true }) !== 7) throw new IncompatibleFamilyTimelineDatabase();
  const rows = db.prepare<[], MigrationRow>("SELECT version, name, sha256 FROM schema_migrations ORDER BY version").all();
  if (rows.length !== MIGRATIONS.length || rows.some((row, i) =>
    row.version !== MIGRATIONS[i]?.[0] || row.name !== MIGRATIONS[i]?.[1] ||
    row.sha256 !== MIGRATIONS[i]?.[2])) throw new IncompatibleFamilyTimelineDatabase();
  if (db.prepare<[], { integrity_check: string }>("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").get() !== undefined) throw new IncompatibleFamilyTimelineDatabase();
  const events = db.prepare<[], { id: string; householdId: string; actorUserId: string | null;
    action: string; entityKind: string; entityId: string | null; outcome: string;
    occurredAt: number; previousHash: string | null; eventHash: string }>(
      "SELECT id, household_id householdId, actor_user_id actorUserId, action, " +
      "entity_kind entityKind, entity_id entityId, outcome, occurred_at occurredAt, " +
      "previous_hash previousHash, event_hash eventHash FROM audit_events ORDER BY sequence",
    ).iterate();
  let previousHash: string | null = null;
  for (const event of events) {
    const canonical: string = JSON.stringify({ action: event.action, actor_user_id: event.actorUserId,
      entity_id: event.entityId, entity_kind: event.entityKind,
      household_id: event.householdId, id: event.id,
      occurred_at: event.occurredAt, outcome: event.outcome,
      previous_hash: previousHash });
    const expected: string = createHash("sha256").update(canonical).digest("hex");
    if (event.previousHash !== previousHash || event.eventHash !== expected)
      throw new IncompatibleFamilyTimelineDatabase();
    previousHash = expected;
  }
}
