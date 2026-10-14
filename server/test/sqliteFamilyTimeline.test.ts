import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { cookieAuthenticator, issueCsrfToken, SESSION_COOKIE_NAME, sessionTokenSha256 } from "../src/auth/cookieSession.js";
import { BootstrapTokenStore } from "../src/auth/bootstrapTokenStore.js";
import { SqliteFamilyAccounts } from "../src/auth/familyAccounts.js";
import { createHttpApp } from "../src/http/app.js";
import { SqliteFamilyTimeline, IncompatibleFamilyTimelineDatabase } from "../src/storage/sqliteFamilyTimeline.js";
import { SqliteFamilyMutations } from "../src/storage/sqliteFamilyMutations.js";
import { createTrustedIntake } from "../src/ingest/trustedIntake.js";
import { createPrivateBackupIdentity } from "../src/backup/privateAgeFile.js";
import { createPrivateSnapshot, restorePrivateSnapshot } from "../src/backup/privateSnapshot.js";

const directory = fileURLToPath(new URL("../../app/storage/migrations/", import.meta.url));
const files = [
  "0001_initial.sql", "0002_cross_scope_guards.sql", "0003_extraction_job_uniqueness.sql",
  "0004_workflow_actor_guards.sql", "0005_managed_e2ee_sync.sql", "0006_sparse_care_days.sql",
  "0007_family_day_access.sql",
];
const names = [
  "initial", "cross_scope_guards", "extraction_job_uniqueness", "workflow_actor_guards",
  "managed_e2ee_sync", "sparse_care_days", "family_day_access",
];
const documentHash = "a".repeat(64);
const pageText = "A fictional laboratory report with no real patient information.";
const pageHash = createHash("sha256").update(pageText).digest("hex");

function emptyDatabase(): { path: string; writer: Database.Database } {
  const path = join(mkdtempSync(join(tmpdir(), "adeno-fictional-family-")), "case.sqlite");
  const writer = new Database(path);
  writer.pragma("foreign_keys = ON");
  writer.pragma("trusted_schema = ON");
  for (const [index, file] of files.entries()) {
    const sql = readFileSync(join(directory, file), "utf8");
    writer.exec(sql);
    writer.prepare("INSERT INTO schema_migrations (version, name, sha256, app_version, applied_at) VALUES (?, ?, ?, 'fictional-test', 100)")
      .run(index + 1, names[index], createHash("sha256").update(sql).digest("hex"));
  }
  writer.pragma("application_id = 1129071687");
  writer.pragma("user_version = 7");
  chmodSync(path, 0o600);
  return { path, writer };
}

function database(): { path: string; writer: Database.Database } {
  const { path, writer } = emptyDatabase();
  writer.prepare("INSERT INTO households (singleton, id, display_name, created_at) VALUES (1, 'family-a', 'Fictional family', 100)").run();
  for (const [id, role, kind] of [
    ["owner-a", "owner", "adult"], ["adult-a", "caregiver", "adult"],
    ["child-a", "caregiver", "child"],
  ]) {
    writer.prepare("INSERT INTO users (id, household_id, login_name, login_name_normalized, display_name, role, status, password_hash, created_at, updated_at, password_changed_at, member_kind) VALUES (?, 'family-a', ?, ?, ?, ?, 'active', '$argon2id$fictional', 100, 100, 100, ?)")
      .run(id, id, id, `Fictional ${id}`, role, kind);
  }
  writer.prepare("INSERT INTO care_profiles (id, household_id, preferred_name, created_by, created_at, updated_at) VALUES ('profile-a', 'family-a', 'Fictional person', 'owner-a', 100, 100)").run();
  writer.prepare("INSERT INTO source_objects (sha256, byte_size, media_type, created_at) VALUES (?, 100, 'application/pdf', 100)").run(documentHash);
  writer.prepare("INSERT INTO documents (id, care_profile_id, source_sha256, original_display_name, scan_verdict, page_count, status, uploaded_by, uploaded_at) VALUES ('document-a', 'profile-a', ?, 'fictional.pdf', 'clean', 1, 'complete', 'owner-a', 100)").run(documentHash);
  writer.prepare("INSERT INTO document_pages (document_id, page_number, extracted_text, text_sha256, created_at) VALUES ('document-a', 1, ?, ?, 100)").run(pageText, pageHash);
  writer.prepare("INSERT INTO document_day_placements (id, care_profile_id, document_id, created_by, created_at) VALUES ('placement-a', 'profile-a', 'document-a', 'owner-a', 100)").run();
  writer.prepare("INSERT INTO document_day_placement_revisions (id, placement_id, revision_no, care_day, created_by, created_at) VALUES ('placement-revision-a', 'placement-a', 1, '2030-04-12', 'owner-a', 100)").run();
  writer.prepare("INSERT INTO document_day_placement_reviews (id, revision_id, decision, reviewer_id, decided_at) VALUES ('placement-review-a', 'placement-revision-a', 'accepted', 'owner-a', 101)").run();
  writer.prepare("INSERT INTO family_notes (id, care_profile_id, created_by, created_at) VALUES ('note-a', 'profile-a', 'owner-a', 100)").run();
  writer.prepare("INSERT INTO family_note_revisions (id, note_id, revision_no, care_day, body, created_by, created_at) VALUES ('note-revision-a', 'note-a', 1, '2030-04-12', 'Fictional family note.', 'owner-a', 100)").run();
  writer.prepare("INSERT INTO family_note_reviews (id, revision_id, decision, reviewer_id, decided_at) VALUES ('note-review-a', 'note-revision-a', 'accepted', 'owner-a', 101)").run();
  writer.prepare("INSERT INTO day_nodes (id, care_profile_id, care_day, created_by, created_at) VALUES ('day-a', 'profile-a', '2030-04-12', 'owner-a', 102)").run();
  writer.prepare("INSERT INTO day_snapshots (id, day_node_id, revision_no, content_sha256, published_by, published_at) VALUES ('snapshot-a', 'day-a', 1, ?, 'owner-a', 102)").run("b".repeat(64));
  writer.prepare("INSERT INTO day_snapshot_entries (snapshot_id, position, placement_revision_id) VALUES ('snapshot-a', 0, 'placement-revision-a')").run();
  writer.prepare("INSERT INTO day_snapshot_entries (snapshot_id, position, note_revision_id) VALUES ('snapshot-a', 1, 'note-revision-a')").run();
  writer.prepare("INSERT INTO day_access_events (id, care_profile_id, care_day, subject_user_id, event_no, level, actor_user_id, occurred_at) VALUES ('grant-day-a', 'profile-a', '2030-04-12', 'adult-a', 1, 'view', 'owner-a', 102)").run();
  return { path, writer };
}

describe("fictional v7 family timeline", () => {
  it("requires current published-day membership as well as source permission before source text reaches AI", async () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 14); const token = "r".repeat(43);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('source-owner', 'owner-a', ?, ?, 1, 100, 4000000000, 100)").run(sessionTokenSha256(token), secret);
    writer.prepare("INSERT INTO documents (id, care_profile_id, source_sha256, original_display_name, scan_verdict, page_count, status, uploaded_by, uploaded_at) " +
      "VALUES ('unpublished-source', 'profile-a', ?, 'Invented unpublished source.pdf', 'clean', 1, 'complete', 'owner-a', 200)").run(documentHash);
    writer.prepare("INSERT INTO document_pages (document_id, page_number, extracted_text, text_sha256, created_at) VALUES ('unpublished-source', 1, ?, ?, 200)")
      .run(pageText, pageHash);
    const preflight = { ok: true as const, tokenSha256: sessionTokenSha256(token), csrfToken: issueCsrfToken("source-owner", secret) };
    const mutations = new SqliteFamilyMutations(path); const reader = new SqliteFamilyTimeline(path);
    const query = { householdId: "family-a", userId: "owner-a", careProfileId: "profile-a", documentId: "unpublished-source", pageNumber: 1, offset: 0, maxChars: 1000 };
    try {
      expect(await reader.readApprovedPageChunk(query)).toBeNull();
      const proposal = mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a", documentId: "unpublished-source", careDay: "2030-04-16", nowSeconds: 201 });
      if (!proposal.ok) throw new Error("Expected synthetic source proposal");
      expect(await reader.readApprovedPageChunk(query)).toBeNull();
      expect(mutations.reviewDocumentDay({ preflight, careProfileId: "profile-a", revisionId: proposal.revisionId,
        expectedDayRevision: 0, decision: "accepted", nowSeconds: 202 })).toMatchObject({ ok: true });
      expect(await reader.readApprovedPageChunk(query)).toMatchObject({ text: pageText, sourceSha256: documentHash });
      expect(mutations.grantDocumentAccess({ preflight, careProfileId: "profile-a", documentId: "unpublished-source",
        subjectUserId: "adult-a", allowed: true, nowSeconds: 203 })).toMatchObject({ ok: true });
      expect(await reader.readApprovedPageChunk({ ...query, userId: "adult-a" })).toBeNull();
      expect(mutations.grantDayAccess({ preflight, careProfileId: "profile-a", careDay: "2030-04-16",
        subjectUserId: "adult-a", level: "view", nowSeconds: 204 })).toMatchObject({ ok: true });
      expect(await reader.readApprovedPageChunk({ ...query, userId: "adult-a" })).toMatchObject({ text: pageText });
      expect(mutations.grantDayAccess({ preflight, careProfileId: "profile-a", careDay: "2030-04-16",
        subjectUserId: "adult-a", level: "none", nowSeconds: 205 })).toMatchObject({ ok: true });
      expect(await reader.readApprovedPageChunk({ ...query, userId: "adult-a" })).toBeNull();
    } finally { reader.close(); mutations.close(); writer.close(); }
  });

  it("paginates a private inbox at tied upload times and removes own-intake access after revocation", async () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 13); const token = "q".repeat(43);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('inbox-owner', 'owner-a', ?, ?, 1, 100, 4000000000, 100)").run(sessionTokenSha256(token), secret);
    const preflight = { ok: true as const, tokenSha256: sessionTokenSha256(token), csrfToken: issueCsrfToken("inbox-owner", secret) };
    const mutations = new SqliteFamilyMutations(path); const reader = new SqliteFamilyTimeline(path);
    const scope = { householdId: "family-a", userId: "owner-a", careProfileId: "profile-a" };
    try {
      expect(mutations.grantProfileIntake({ preflight, careProfileId: "profile-a", subjectUserId: "child-a", allowed: true, nowSeconds: 200 })).toMatchObject({ ok: true });
      for (let index = 0; index < 22; index++) writer.prepare(
        "INSERT INTO documents (id, care_profile_id, source_sha256, original_display_name, scan_verdict, page_count, status, uploaded_by, uploaded_at) " +
        "VALUES (?, 'profile-a', ?, 'Independently invented inbox record.pdf', 'clean', 1, 'needs_review', ?, 201)",
      ).run(`inbox-${String(index).padStart(2, "0")}`, documentHash, index === 0 ? "child-a" : "owner-a");
      const first = await reader.listDocumentInbox(scope);
      expect(first.documents).toHaveLength(20); expect(first.nextCursor).toEqual({ uploadedAt: 201, documentId: "inbox-02" });
      const second = await reader.listDocumentInbox({ ...scope, before: first.nextCursor! });
      expect(second.documents).toHaveLength(3); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.documents, ...second.documents].map(document => document.documentId)).size).toBe(23);
      expect((await reader.listDocumentInbox({ ...scope, userId: "child-a" })).documents.map(document => document.documentId)).toEqual(["inbox-00"]);
      expect((await reader.listDocumentInbox({ ...scope, userId: "adult-a" })).documents).toEqual([]);
      expect((await reader.listDocumentInbox({ ...scope, householdId: "other-family" })).documents).toEqual([]);
      const proposed = mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a", documentId: "inbox-00", careDay: "2030-04-15", nowSeconds: 202 });
      if (!proposed.ok) throw new Error("Expected synthetic inbox placement");
      expect((await reader.listDocumentInbox({ ...scope, before: first.nextCursor! })).documents.find(document => document.documentId === "inbox-00")?.pendingDayProposals)
        .toEqual([{ revisionId: proposed.revisionId, careDay: "2030-04-15" }]);
      expect((await reader.listDocumentInbox({ ...scope, userId: "child-a" })).documents[0]?.pendingDayProposals).toEqual([]);
      const imageHash = "c".repeat(64);
      writer.prepare("INSERT INTO source_objects (sha256, byte_size, media_type, created_at) VALUES (?, 20, 'image/png', 201)").run(imageHash);
      writer.prepare("INSERT INTO documents (id, care_profile_id, source_sha256, original_display_name, scan_verdict, page_count, status, uploaded_by, uploaded_at) " +
        "VALUES ('image-original-a', 'profile-a', ?, 'Invented original.png', 'clean', 1, 'needs_review', 'child-a', 201)").run(imageHash);
      writer.prepare("INSERT INTO document_pages (document_id, page_number, created_at) VALUES ('image-original-a', 1, 201)").run();
      const source = { ...scope, documentId: "image-original-a" };
      expect(await reader.readOriginalImageReference(source)).toEqual({ sourceSha256: imageHash, byteSize: 20, mediaType: "image/png" });
      expect(await reader.readApprovedImageReference(source)).toBeNull();
      const imageProposal = mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a", documentId: "image-original-a", careDay: "2030-04-17", nowSeconds: 202 });
      if (!imageProposal.ok) throw new Error("Expected synthetic image proposal");
      expect(await reader.readApprovedImageReference(source)).toBeNull();
      expect(mutations.reviewDocumentDay({ preflight, careProfileId: "profile-a", revisionId: imageProposal.revisionId,
        expectedDayRevision: 0, decision: "accepted", nowSeconds: 203 })).toMatchObject({ ok: true });
      expect(await reader.readApprovedImageReference(source)).toEqual({ sourceSha256: imageHash, byteSize: 20, mediaType: "image/png" });
      expect(await reader.readApprovedImageReference({ ...source, userId: "child-a" })).toBeNull();
      expect(await reader.readOriginalImageReference({ ...source, userId: "child-a" })).toBeTruthy();
      expect(await reader.readOriginalImageReference({ ...source, userId: "adult-a" })).toBeNull();
      expect(await reader.readOriginalImageReference({ ...source, householdId: "other-family" })).toBeNull();
      expect(await reader.readOriginalImageReference({ ...scope, documentId: "document-a" })).toBeNull(); // PDF is never an image.
      expect(mutations.grantDocumentAccess({ preflight, careProfileId: "profile-a", documentId: "image-original-a",
        subjectUserId: "adult-a", allowed: true, nowSeconds: 203 })).toMatchObject({ ok: true });
      expect(await reader.readOriginalImageReference({ ...source, userId: "adult-a" })).toBeTruthy();
      expect(await reader.readApprovedImageReference({ ...source, userId: "adult-a" })).toBeNull(); // No published-day grant.
      expect(mutations.grantDayAccess({ preflight, careProfileId: "profile-a", careDay: "2030-04-17", subjectUserId: "adult-a",
        level: "view", nowSeconds: 203 })).toMatchObject({ ok: true });
      expect(await reader.readApprovedImageReference({ ...source, userId: "adult-a" })).toBeTruthy();
      expect(mutations.grantDocumentAccess({ preflight, careProfileId: "profile-a", documentId: "image-original-a",
        subjectUserId: "adult-a", allowed: false, nowSeconds: 203 })).toMatchObject({ ok: true });
      expect(await reader.readOriginalImageReference({ ...source, userId: "adult-a" })).toBeNull();
      expect(await reader.readApprovedImageReference({ ...source, userId: "adult-a" })).toBeNull();
      expect(mutations.grantProfileIntake({ preflight, careProfileId: "profile-a", subjectUserId: "child-a", allowed: false, nowSeconds: 203 })).toMatchObject({ ok: true });
      expect((await reader.listDocumentInbox({ ...scope, userId: "child-a" })).documents).toEqual([]);
      expect(await reader.readOriginalImageReference({ ...source, userId: "child-a" })).toBeNull();
    } finally { reader.close(); mutations.close(); writer.close(); }
  });

  it("holds document-day proposals out of history and checks freshness before source-linked publication", async () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 12);
    const token = "p".repeat(43);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('placement-owner', 'owner-a', ?, ?, 1, 100, 4000000000, 100)").run(sessionTokenSha256(token), secret);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('placement-child', 'child-a', ?, ?, 1, 100, 4000000000, 100)").run(sessionTokenSha256("k".repeat(43)), secret);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('placement-adult', 'adult-a', ?, ?, 1, 100, 4000000000, 100)").run(sessionTokenSha256("m".repeat(43)), secret);
    const preflight = { ok: true as const, tokenSha256: sessionTokenSha256(token),
      csrfToken: issueCsrfToken("placement-owner", secret) };
    const child = { ok: true as const, tokenSha256: sessionTokenSha256("k".repeat(43)),
      csrfToken: issueCsrfToken("placement-child", secret) };
    const adult = { ok: true as const, tokenSha256: sessionTokenSha256("m".repeat(43)),
      csrfToken: issueCsrfToken("placement-adult", secret) };
    const mutations = new SqliteFamilyMutations(path); const reader = new SqliteFamilyTimeline(path);
    const scope = { householdId: "family-a", userId: "owner-a", careProfileId: "profile-a" };
    const pendingCount = () => (writer.prepare("SELECT count(*) n FROM document_day_placement_reviews").get() as { n: number }).n;
    try {
      expect(mutations.proposeDocumentDay({ preflight: child, careProfileId: "profile-a",
        documentId: "document-a", careDay: "2030-04-13", nowSeconds: 200 })).toMatchObject({ ok: false, error: "FORBIDDEN" });
      expect(mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a",
        documentId: "missing-document", careDay: "2030-04-13", nowSeconds: 200 })).toMatchObject({ ok: false, error: "NOT_FOUND" });
      const proposed = mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a",
        documentId: "document-a", careDay: "2030-04-13", nowSeconds: 200 });
      if (!proposed.ok) throw new Error("Expected synthetic placement proposal");
      expect(await reader.readPendingDocumentDay({ ...scope, revisionId: proposed.revisionId })).toMatchObject({
        documentId: "document-a", sourceSha256: documentHash, pageCount: 1, expectedDayRevision: 0, state: "proposed" });
      expect(await reader.readPendingDocumentDay({ ...scope, userId: "child-a", revisionId: proposed.revisionId })).toBeNull();
      expect(mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a",
        documentId: "document-a", careDay: "2030-04-13", nowSeconds: 200 })).toMatchObject({ ok: false, error: "DUPLICATE_PLACEMENT" });
      expect((await reader.listApprovedDays({ ...scope, throughDay: "2030-04-30", limit: 10 })).map(day => day.day)).toEqual(["2030-04-12"]);
      const note = mutations.proposeNote({ preflight, careProfileId: "profile-a", careDay: "2030-04-13",
        body: "An independently invented note alongside the source.", nowSeconds: 201 });
      if (!note.ok) throw new Error("Expected synthetic note");
      expect(mutations.reviewNote({ preflight, careProfileId: "profile-a", revisionId: note.revisionId,
        expectedDayRevision: 0, decision: "accepted", nowSeconds: 202 })).toMatchObject({ ok: true, revision: 1 });
      const countBefore = pendingCount();
      expect(mutations.grantDayAccess({ preflight, careProfileId: "profile-a", careDay: "2030-04-13",
        subjectUserId: "adult-a", level: "publish", nowSeconds: 202 })).toMatchObject({ ok: true });
      expect(mutations.reviewDocumentDay({ preflight: adult, careProfileId: "profile-a", revisionId: proposed.revisionId,
        expectedDayRevision: 1, decision: "accepted", nowSeconds: 203 })).toMatchObject({ ok: false, error: "FORBIDDEN" });
      expect(await reader.readPendingDocumentDay({ ...scope, userId: "adult-a", revisionId: proposed.revisionId })).toBeNull();
      for (const allowed of [true, false]) expect(mutations.grantDocumentAccess({ preflight, careProfileId: "profile-a",
        documentId: "document-a", subjectUserId: "adult-a", allowed, nowSeconds: 203 })).toMatchObject({ ok: true });
      expect(mutations.reviewDocumentDay({ preflight: adult, careProfileId: "profile-a", revisionId: proposed.revisionId,
        expectedDayRevision: 1, decision: "accepted", nowSeconds: 203 })).toMatchObject({ ok: false, error: "FORBIDDEN" });
      expect(mutations.reviewDocumentDay({ preflight: child, careProfileId: "profile-a", revisionId: proposed.revisionId,
        expectedDayRevision: 1, decision: "accepted", nowSeconds: 203 })).toMatchObject({ ok: false, error: "FORBIDDEN" });
      expect(mutations.reviewDocumentDay({ preflight, careProfileId: "profile-a", revisionId: proposed.revisionId,
        expectedDayRevision: 0, decision: "accepted", nowSeconds: 203 })).toMatchObject({ ok: false, error: "STALE_REVISION" });
      expect(pendingCount()).toBe(countBefore);
      expect(mutations.reviewDocumentDay({ preflight, careProfileId: "profile-a", revisionId: proposed.revisionId,
        expectedDayRevision: 1, decision: "accepted", nowSeconds: 204 })).toMatchObject({ ok: true, revision: 2 });
      const days = await reader.listApprovedDays({ ...scope, throughDay: "2030-04-30", limit: 10 });
      expect(await reader.readPendingDocumentDay({ ...scope, revisionId: proposed.revisionId })).toBeNull();
      expect(days[0]).toMatchObject({ day: "2030-04-13", revision: 2,
        sources: [{ documentId: "document-a", sourceSha256: documentHash, pageNumbers: [1] }] });
      expect(days[0]?.statements).toHaveLength(1);
      expect(days[1]?.revision).toBe(1);
      expect(mutations.reviewDocumentDay({ preflight, careProfileId: "profile-a", revisionId: proposed.revisionId,
        expectedDayRevision: 2, decision: "accepted", nowSeconds: 205 })).toMatchObject({ ok: false, error: "NOT_FOUND" });
      const rejected = mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a",
        documentId: "document-a", careDay: "2030-04-14", nowSeconds: 206 });
      if (!rejected.ok) throw new Error("Expected synthetic rejection proposal");
      expect(mutations.reviewDocumentDay({ preflight, careProfileId: "profile-a", revisionId: rejected.revisionId,
        expectedDayRevision: 0, decision: "rejected", nowSeconds: 207 })).toMatchObject({ ok: true, snapshotId: null, revision: 0 });
      expect((await reader.listApprovedDays({ ...scope, throughDay: "2030-04-30", limit: 10 }))).toHaveLength(2);
      writer.prepare("UPDATE sessions SET revoked_at = 208 WHERE id = 'placement-owner'").run();
      expect(mutations.proposeDocumentDay({ preflight, careProfileId: "profile-a",
        documentId: "document-a", careDay: "2030-04-15", nowSeconds: 209 })).toMatchObject({ ok: false, error: "AUTH_REQUIRED" });
    } finally { reader.close(); mutations.close(); writer.close(); }
  });

  it("restores an encrypted paired database and original without reviving sessions or altering the source", async () => {
    const { path, writer } = emptyDatabase();
    const root = mkdtempSync(join(tmpdir(), "adeno-fictional-snapshot-"));
    const objectRoot = join(root, "objects"); mkdirSync(objectRoot, { mode: 0o700 });
    const bytes = Buffer.from("An independently invented original for the backup regression.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const shard = join(objectRoot, hash.slice(0, 2), hash.slice(2, 4));
    mkdirSync(shard, { recursive: true, mode: 0o700 });
    writeFileSync(join(shard, hash), bytes, { mode: 0o400 });
    const pepperPath = join(root, "recovery-pepper");
    const pepper = Buffer.alloc(32, 7); writeFileSync(pepperPath, pepper, { mode: 0o600 });
    writer.prepare("INSERT INTO households (singleton, id, display_name, created_at) VALUES (1, 'backup-family', 'Invented backup family', 100)").run();
    writer.prepare("INSERT INTO users (id, household_id, login_name, login_name_normalized, display_name, role, status, password_hash, created_at, updated_at, password_changed_at, member_kind) " +
      "VALUES ('backup-owner', 'backup-family', 'backup-owner', 'backup-owner', 'Invented owner', 'owner', 'active', '$argon2id$fictional', 100, 100, 100, 'adult')").run();
    writer.prepare("INSERT INTO care_profiles (id, household_id, preferred_name, created_by, created_at, updated_at) " +
      "VALUES ('backup-profile', 'backup-family', 'Invented person', 'backup-owner', 100, 100)").run();
    writer.prepare("INSERT INTO source_objects (sha256, byte_size, media_type, created_at) VALUES (?, ?, 'image/png', 100)").run(hash, bytes.length);
    writer.prepare("INSERT INTO documents (id, care_profile_id, source_sha256, original_display_name, scan_verdict, status, uploaded_by, uploaded_at) " +
      "VALUES ('backup-document', 'backup-profile', ?, 'invented.png', 'clean', 'needs_review', 'backup-owner', 100)").run(hash);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('backup-session', 'backup-owner', ?, ?, 1, 100, 4000000000, 100)").run("f".repeat(64), Buffer.alloc(32, 9));
    writer.close();
    const sourceBefore = createHash("sha256").update(readFileSync(path)).digest("hex");
    const identityPath = join(root, "off-host-test-identity");
    const { recipient } = await createPrivateBackupIdentity(identityPath);
    const encryptedPath = join(root, "generation.age");
    const encrypted = await createPrivateSnapshot({ sourceDbPath: path, objectRoot,
      recoveryPepperPath: pepperPath, snapshotRoot: join(root, "snapshot"), encryptedPath, recipient, writersStopped: true });
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(sourceBefore);
    const source = new Database(path, { readonly: true });
    try { expect(source.prepare("SELECT revoked_at FROM sessions").get()).toEqual({ revoked_at: null }); }
    finally { source.close(); }
    const destinationRoot = join(root, "restore");
    await restorePrivateSnapshot({ encryptedPath, expectedSha256: encrypted.sha256, identityPath,
      workRoot: join(root, "restore-work"), destinationRoot });
    const data = join(destinationRoot, "data");
    expect(readFileSync(join(data, "objects", hash.slice(0, 2), hash.slice(2, 4), hash))).toEqual(bytes);
    expect(readFileSync(join(data, "secrets", "recovery-pepper"))).toEqual(pepper);
    const restored = new Database(join(data, "case.sqlite"), { readonly: true });
    try {
      expect(restored.prepare("SELECT id, source_sha256 FROM documents").all()).toEqual([{ id: "backup-document", source_sha256: hash }]);
      expect(restored.prepare("SELECT 1 FROM sessions WHERE revoked_at IS NULL").get()).toBeUndefined();
    } finally { restored.close(); }
    await expect(restorePrivateSnapshot({ encryptedPath, expectedSha256: "0".repeat(64), identityPath,
      workRoot: join(root, "wrong-pin-work"), destinationRoot: join(root, "wrong-pin-restore") })).rejects.toThrow();
    await expect(restorePrivateSnapshot({ encryptedPath, expectedSha256: encrypted.sha256, identityPath,
      workRoot: join(root, "second-work"), destinationRoot })).rejects.toThrow();
  });

  it("authorizes only a current adult session for an agent approval", () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 8);
    for (const [user, token] of [["owner-a", "a".repeat(43)], ["child-a", "c".repeat(43)]]) {
      writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, " +
        "created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 100, 4000000000, 100)")
        .run(`agent-${user}`, user, sessionTokenSha256(token!), secret);
    }
    const mutations = new SqliteFamilyMutations(path);
    const preflight = { ok: true as const, tokenSha256: sessionTokenSha256("a".repeat(43)),
      csrfToken: issueCsrfToken("agent-owner-a", secret) };
    try {
      expect(mutations.authorizeAgentConnection(preflight)).toMatchObject({ ok: true, owner: {
        userId: "owner-a", householdId: "family-a", sessionId: "agent-owner-a",
        sessionTokenSha256: preflight.tokenSha256,
      } });
      expect(mutations.authorizeAgentConnection({ ...preflight, csrfToken: "wrong" }))
        .toMatchObject({ ok: false, error: "INVALID_CSRF" });
      expect(mutations.authorizeAgentConnection({ ok: true, tokenSha256: sessionTokenSha256("c".repeat(43)),
        csrfToken: issueCsrfToken("agent-child-a", secret) })).toMatchObject({ ok: false, error: "FORBIDDEN" });
      writer.prepare("UPDATE sessions SET revoked_at = 200 WHERE id = 'agent-owner-a'").run();
      expect(mutations.authorizeAgentConnection(preflight)).toMatchObject({ ok: false, error: "AUTH_REQUIRED" });
    } finally { mutations.close(); writer.close(); }
  });

  it("records inspected images for review, deduplicates per profile and denies a revoked upload", async () => {
    const { path, writer } = database();
    const token = "i".repeat(43);
    const secret = Buffer.alloc(32, 5);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, " +
      "auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('intake-session', 'owner-a', ?, ?, 1, 100, 4000000000, 100)")
      .run(sessionTokenSha256(token), secret);
    const mutations = new SqliteFamilyMutations(path);
    const reader = new SqliteFamilyTimeline(path);
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.from("independently invented database intake")]);
    let revoke = false;
    const intake = createTrustedIntake({ repository: mutations,
      quarantineRoot: mkdtempSync(join(tmpdir(), "adeno-fictional-db-intake-stage-")),
      objectRoot: mkdtempSync(join(tmpdir(), "adeno-fictional-db-intake-objects-")),
      storageAvailable: async () => true,
      scanner: { scan: async () => {
        if (revoke) writer.prepare("UPDATE sessions SET revoked_at = ? WHERE id = 'intake-session'")
          .run(Math.floor(Date.now() / 1000));
        return { verdict: "clean", engine: "fictional-test-double" };
      } }, parser: { inspect: async () => ({ status: "safe", pageCount: 1 }) } });
    const upload = { preflight: { ok: true as const, tokenSha256: sessionTokenSha256(token),
      csrfToken: issueCsrfToken("intake-session", secret) }, careProfileId: "profile-a",
      bytes, originalName: "invented.png", claimedMediaType: "image/png" };
    try {
      const first = await intake(upload);
      expect(first).toMatchObject({ ok: true, alreadyExisted: false });
      if (!first.ok) throw new Error("Expected fictional image metadata receipt");
      expect(writer.prepare("SELECT status, record_date, uploaded_by FROM documents WHERE id = ?").get(first.documentId))
        .toEqual({ status: "needs_review", record_date: null, uploaded_by: "owner-a" });
      const count = writer.prepare("SELECT count(*) total FROM documents").get();
      expect(await intake(upload)).toEqual({ ok: true, documentId: first.documentId, alreadyExisted: true });
      expect(writer.prepare("SELECT count(*) total FROM documents").get()).toEqual(count);
      expect(writer.prepare("SELECT count(*) total FROM day_nodes").get()).toEqual({ total: 1 });
      expect(reader.ready()).toBe(true);
      revoke = true;
      expect(await intake({ ...upload, bytes: Buffer.concat([bytes, Buffer.from("another invented image")]) }))
        .toMatchObject({ ok: false, status: 401, error: "AUTH_REQUIRED" });
      expect(writer.prepare("SELECT count(*) total FROM documents").get()).toEqual(count);
    } finally { reader.close(); mutations.close(); writer.close(); }
  });

  it("creates profiles only for a live adult owner session and audits the same transaction", async () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 4);
    const token = "p".repeat(43);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, " +
      "auth_version, created_at, expires_at, last_seen_at) " +
      "VALUES ('profile-session', 'owner-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(token), secret);
    const preflight = { ok: true as const, tokenSha256: sessionTokenSha256(token),
      csrfToken: issueCsrfToken("profile-session", secret) };
    const mutations = new SqliteFamilyMutations(path);
    const reader = new SqliteFamilyTimeline(path);
    try {
      const result = mutations.createCareProfile({ preflight,
        preferredName: "  Independently invented person  ", nowSeconds: 200 });
      expect(result).toMatchObject({ ok: true, preferredName: "Independently invented person" });
      if (!result.ok) throw new Error("Expected fictional owner creation");
      expect(writer.prepare("SELECT household_id, created_by FROM care_profiles WHERE id = ?").get(result.id))
        .toEqual({ household_id: "family-a", created_by: "owner-a" });
      expect(writer.prepare("SELECT action, entity_id FROM audit_events ORDER BY sequence DESC LIMIT 1").get())
        .toEqual({ action: "care_profile_created", entity_id: result.id });
      expect(reader.ready()).toBe(true);
      expect(await reader.listVisibleCareProfiles({ householdId: "family-a", userId: "owner-a" }))
        .toContainEqual({ id: result.id, preferredName: "Independently invented person" });
      const count = writer.prepare("SELECT count(*) total FROM care_profiles").get();
      expect(mutations.createCareProfile({ preflight: { ...preflight, csrfToken: "wrong" },
        preferredName: "Denied person", nowSeconds: 200 })).toMatchObject({ ok: false, error: "INVALID_CSRF" });
      writer.prepare("UPDATE sessions SET revoked_at = 201 WHERE id = 'profile-session'").run();
      expect(mutations.createCareProfile({ preflight, preferredName: "Denied person", nowSeconds: 202 }))
        .toMatchObject({ ok: false, error: "AUTH_REQUIRED" });
      expect(writer.prepare("SELECT count(*) total FROM care_profiles").get()).toEqual(count);
    } finally { reader.close(); mutations.close(); writer.close(); }
  });

  it("reveals pending note text only to a current authorized adult reviewer", async () => {
    const { path, writer } = database();
    writer.prepare("INSERT INTO family_notes (id, care_profile_id, created_by, created_at) " +
      "VALUES ('pending-note', 'profile-a', 'child-a', 200)").run();
    writer.prepare("INSERT INTO family_note_revisions (id, note_id, revision_no, care_day, " +
      "body, created_by, created_at) VALUES ('pending-revision', 'pending-note', 1, " +
      "'2030-04-12', 'Independent fictional pending note.', 'child-a', 200)").run();
    const reader = new SqliteFamilyTimeline(path);
    const input = { householdId: "family-a", careProfileId: "profile-a",
      revisionId: "pending-revision" };
    try {
      const detail = await reader.readPendingNote({ ...input, userId: "owner-a" });
      expect(detail).toMatchObject({ body: "Independent fictional pending note.",
        careDay: "2030-04-12", expectedDayRevision: 1, state: "proposed",
        attribution: "family_note", authorLabel: "Fictional child-a" });
      expect(await reader.readPendingNote({ ...input, userId: "adult-a" })).toBeNull();
      expect(await reader.readPendingNote({ ...input, userId: "child-a" })).toBeNull();
      expect(await reader.readPendingNote({ ...input, userId: "owner-a",
        householdId: "family-b" })).toBeNull();
      expect(await reader.readPendingNote({ ...input, userId: "owner-a",
        careProfileId: "other-profile" })).toBeNull();
      expect(await reader.readPendingNote({ ...input, userId: "owner-a",
        revisionId: "note-revision-a" })).toBeNull(); // Already reviewed.
      writer.prepare("INSERT INTO day_access_events (id, care_profile_id, care_day, " +
        "subject_user_id, event_no, level, actor_user_id, occurred_at) " +
        "VALUES ('publish-grant', 'profile-a', '2030-04-12', 'adult-a', 2, 'publish', 'owner-a', 201)").run();
      expect(await reader.readPendingNote({ ...input, userId: "adult-a" })).not.toBeNull();
      writer.prepare("INSERT INTO day_access_events (id, care_profile_id, care_day, " +
        "subject_user_id, event_no, level, actor_user_id, occurred_at) " +
        "VALUES ('publish-revoked', 'profile-a', '2030-04-12', 'adult-a', 3, 'view', 'owner-a', 202)").run();
      expect(await reader.readPendingNote({ ...input, userId: "adult-a" })).toBeNull();
      writer.prepare("INSERT INTO family_note_reviews (id, revision_id, decision, reviewer_id, decided_at) " +
        "VALUES ('pending-rejected', 'pending-revision', 'rejected', 'owner-a', 203)").run();
      expect(await reader.readPendingNote({ ...input, userId: "owner-a" })).toBeNull();
    } finally { reader.close(); writer.close(); }
  });

  it("sets up the owner once with private bootstrap and recovery codes", async () => {
    const { path, writer } = emptyDatabase();
    const secretDirectory = mkdtempSync(join(tmpdir(), "adeno-fictional-bootstrap-"));
    const bootstrap = new BootstrapTokenStore(secretDirectory);
    const token = bootstrap.initialize();
    if (!token) throw new Error("Expected fictional bootstrap token");
    const accounts = new SqliteFamilyAccounts(path);
    try {
      const setup = await accounts.setupOwner({ token, displayName: "Fictional owner",
        householdName: "Fictional household", password: "a fictional owner password",
        bootstrap, recoveryPepper: Buffer.alloc(32, 7) });
      if (!setup.ok) throw new Error(`Expected setup, received ${setup.error}`);
      expect(setup.value.recoveryCodes).toHaveLength(10);
      expect(bootstrap.verify(token)).toBe(false);
      expect(await accounts.setupOwner({ token, displayName: "Second",
        householdName: "Second", password: "a fictional owner password",
        bootstrap, recoveryPepper: Buffer.alloc(32, 7) }))
        .toEqual({ ok: false, error: "SETUP_COMPLETE" });
      expect(await accounts.login({ loginName: "owner", password: "a fictional owner password" }))
        .toMatchObject({ ok: true, value: { userId: setup.value.userId, role: "owner" } });
      const recovered = await accounts.recoverOwner({ code: setup.value.recoveryCodes[0]!,
        newPassword: "a different fictional password", recoveryPepper: Buffer.alloc(32, 7) });
      if (!recovered.ok) throw new Error("Expected fictional owner recovery");
      expect(recovered.value.recoveryCodes).toHaveLength(10);
      expect(await accounts.recoverOwner({ code: setup.value.recoveryCodes[0]!,
        newPassword: "another fictional password", recoveryPepper: Buffer.alloc(32, 7) }))
        .toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
      expect(await accounts.login({ loginName: "owner", password: "a fictional owner password" }))
        .toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
      expect(await accounts.login({ loginName: "owner", password: "a different fictional password" }))
        .toMatchObject({ ok: true, value: { userId: setup.value.userId } });
      const priorSession = writer.prepare("SELECT revoked_at revokedAt FROM sessions WHERE token_sha256 = ?")
        .get(sessionTokenSha256(setup.value.sessionToken)) as { revokedAt: number | null };
      expect(priorSession.revokedAt).not.toBeNull();
    } finally { accounts.close(); writer.close(); }
  });
  it("keeps the bootstrap secret out of web JSON while permitting local owner setup", async () => {
    const { path, writer } = emptyDatabase();
    const bootstrap = new BootstrapTokenStore(mkdtempSync(join(tmpdir(), "adeno-fictional-setup-http-")));
    const token = bootstrap.initialize();
    if (!token) throw new Error("Expected fictional token");
    const accounts = new SqliteFamilyAccounts(path);
    const reader = new SqliteFamilyTimeline(path);
    const app = createHttpApp({ authenticate: cookieAuthenticator(reader), timeline: reader,
      pages: reader, accounts, sessions: reader,
      ownerSetup: { bootstrap, recoveryPepper: Buffer.alloc(32, 7) },
      expectedOrigin: "http://127.0.0.1:9999", readiness: () => reader.ready() });
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test listener unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await (await fetch(`${base}/api/v2/auth/setup-status`)).json()).setupRequired).toBe(true);
      expect((await (await fetch(`${base}/health/ready`)).json()).status).toBe("ready");
      const response = await fetch(`${base}/api/v2/auth/setup`, { method: "POST",
        headers: { origin: "http://127.0.0.1:9999", "content-type": "application/json" },
        body: JSON.stringify({ token, displayName: "Fictional owner",
          householdName: "Fictional family", password: "fictional owner password" }) });
      expect(response.status).toBe(201);
      const body = await response.json() as { recoveryCodes: string[] };
      expect(body.recoveryCodes).toHaveLength(10);
      expect(JSON.stringify(body)).not.toContain(token);
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");
      expect((await (await fetch(`${base}/api/v2/auth/setup-status`)).json()).setupRequired).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      reader.close(); accounts.close(); writer.close();
    }
  });
  it("separates day access from original-source access and checks revocations afresh", async () => {
    const { path, writer } = database();
    const reader = new SqliteFamilyTimeline(path);
    const input = { householdId: "family-a", careProfileId: "profile-a", throughDay: "2030-04-30", limit: 10 };
    try {
      const owner = await reader.listApprovedDays({ ...input, userId: "owner-a" });
      expect(await reader.isActiveAdult({ householdId: "family-a", userId: "owner-a" })).toBe(true);
      expect(await reader.isActiveAdult({ householdId: "family-a", userId: "child-a" })).toBe(false);
      expect(await reader.isActiveAdult({ householdId: "other-family", userId: "owner-a" })).toBe(false);
      expect(owner[0]?.sources[0]?.displayName).toBe("fictional.pdf");
      expect(owner[0]?.statements[0]?.text).toBe("Fictional family note.");
      const adult = await reader.listApprovedDays({ ...input, userId: "adult-a" });
      expect(adult[0]?.sources).toEqual([]);
      expect(adult[0]?.statements).toHaveLength(1);
      expect(await reader.listVisibleCareProfiles({ householdId: "family-a", userId: "adult-a" }))
        .toEqual([{ id: "profile-a", preferredName: "Fictional person" }]);
      expect(await reader.listVisibleCareProfiles({ householdId: "family-a", userId: "child-a" }))
        .toEqual([]);
      expect(await reader.readApprovedPageChunk({ ...input, userId: "adult-a", documentId: "document-a", pageNumber: 1, offset: 0, maxChars: 6000 })).toBeNull();
      expect(await reader.listApprovedDays({ ...input, userId: "child-a" })).toEqual([]);
      writer.prepare("INSERT INTO document_access_events (id, care_profile_id, document_id, subject_user_id, event_no, allowed, actor_user_id, occurred_at) VALUES ('grant-source-a', 'profile-a', 'document-a', 'adult-a', 1, 1, 'owner-a', 103)").run();
      expect((await reader.listApprovedDays({ ...input, userId: "adult-a" }))[0]?.sources).toHaveLength(1);
      expect((await reader.readApprovedPageChunk({ ...input, userId: "adult-a", documentId: "document-a", pageNumber: 1, offset: 0, maxChars: 20 }))?.text).toBe(pageText.slice(0, 20));
      writer.prepare("INSERT INTO document_access_events (id, care_profile_id, document_id, subject_user_id, event_no, allowed, actor_user_id, occurred_at) VALUES ('revoke-source-a', 'profile-a', 'document-a', 'adult-a', 2, 0, 'owner-a', 104)").run();
      expect((await reader.listApprovedDays({ ...input, userId: "adult-a" }))[0]?.sources).toEqual([]);
      writer.prepare("INSERT INTO day_access_events (id, care_profile_id, care_day, subject_user_id, event_no, level, actor_user_id, occurred_at) VALUES ('revoke-day-a', 'profile-a', '2030-04-12', 'adult-a', 2, 'none', 'owner-a', 105)").run();
      expect(await reader.listApprovedDays({ ...input, userId: "adult-a" })).toEqual([]);
      expect(await reader.listVisibleCareProfiles({ householdId: "family-a", userId: "adult-a" }))
        .toEqual([]);
    } finally { reader.close(); writer.close(); }
  });

  it("rejects an altered migration ledger", () => {
    const { path, writer } = database();
    writer.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 7").run("0".repeat(64));
    writer.close();
    expect(() => new SqliteFamilyTimeline(path)).toThrow(IncompatibleFamilyTimelineDatabase);
  });

  it("refuses a structurally valid database with a broken append-only audit chain", () => {
    const { path, writer } = database();
    writer.prepare("INSERT INTO audit_events (id, household_id, actor_user_id, action, entity_kind, " +
      "entity_id, outcome, occurred_at, event_hash) " +
      "VALUES ('bad-audit', 'family-a', 'owner-a', 'fictional_action', 'user', 'owner-a', " +
      "'success', 200, ?)").run("0".repeat(64));
    writer.close();
    expect(() => new SqliteFamilyTimeline(path)).toThrow(IncompatibleFamilyTimelineDatabase);
  });

  it("checks session and owner role inside a write transaction, then records an auditable grant", async () => {
    const { path, writer } = database();
    const ownerToken = "o".repeat(43);
    const adultToken = "d".repeat(43);
    const secret = Buffer.alloc(32, 7);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-owner', 'owner-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(ownerToken), secret);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-adult', 'adult-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(adultToken), secret);
    const ownerPreflight = { ok: true as const, tokenSha256: sessionTokenSha256(ownerToken),
      csrfToken: issueCsrfToken("session-owner", secret) };
    const adultPreflight = { ok: true as const, tokenSha256: sessionTokenSha256(adultToken),
      csrfToken: issueCsrfToken("session-adult", secret) };
    const mutations = new SqliteFamilyMutations(path);
    const reader = new SqliteFamilyTimeline(path);
    try {
      const base = { careProfileId: "profile-a", careDay: "2030-04-12", subjectUserId: "child-a", nowSeconds: 200 };
      expect(mutations.grantDayAccess({ ...base, preflight: adultPreflight, level: "view" }))
        .toMatchObject({ ok: false, status: 403, error: "FORBIDDEN" });
      expect(mutations.grantDayAccess({ ...base,
        preflight: { ...ownerPreflight, csrfToken: "invalid" }, level: "view" }))
        .toMatchObject({ ok: false, status: 403, error: "INVALID_CSRF" });
      expect(mutations.grantDayAccess({ ...base, preflight: ownerPreflight, level: "publish" }))
        .toMatchObject({ ok: false, status: 403, error: "FORBIDDEN" });
      expect(mutations.grantDayAccess({ ...base, preflight: ownerPreflight, level: "view" }))
        .toMatchObject({ ok: true, eventNo: 1 });
      expect(mutations.grantDocumentAccess({ preflight: ownerPreflight,
        careProfileId: "profile-a", documentId: "document-a", subjectUserId: "adult-a",
        allowed: true, nowSeconds: 200 })).toMatchObject({ ok: true, eventNo: 1 });
      expect((await reader.readApprovedPageChunk({ householdId: "family-a", userId: "adult-a",
        careProfileId: "profile-a", documentId: "document-a", pageNumber: 1,
        offset: 0, maxChars: 6000 }))?.text).toBe(pageText);
      expect(mutations.grantDocumentAccess({ preflight: ownerPreflight,
        careProfileId: "profile-a", documentId: "document-a", subjectUserId: "adult-a",
        allowed: false, nowSeconds: 200 })).toMatchObject({ ok: true, eventNo: 2 });
      expect(await reader.readApprovedPageChunk({ householdId: "family-a", userId: "adult-a",
        careProfileId: "profile-a", documentId: "document-a", pageNumber: 1,
        offset: 0, maxChars: 6000 })).toBeNull();
      expect(await reader.listApprovedDays({ householdId: "family-a", userId: "child-a",
        careProfileId: "profile-a", throughDay: "2030-04-30", limit: 10 })).toHaveLength(1);
      writer.prepare("UPDATE sessions SET revoked_at = 201 WHERE id = 'session-owner'").run();
      expect(mutations.grantDayAccess({ ...base, preflight: ownerPreflight, level: "none", nowSeconds: 202 }))
        .toMatchObject({ ok: false, status: 401, error: "AUTH_REQUIRED" });
      expect(writer.prepare("SELECT count(*) n FROM day_access_events WHERE subject_user_id = 'child-a'").get())
        .toMatchObject({ n: 1 });
      const audit = writer.prepare("SELECT * FROM audit_events").all() as { id: string; event_hash: string; previous_hash: string | null;
        household_id: string; actor_user_id: string; action: string; entity_kind: string; entity_id: string;
        outcome: string; occurred_at: number }[];
      expect(audit).toHaveLength(3);
      const row = audit[0]!;
      const canonical = JSON.stringify({ action: row.action, actor_user_id: row.actor_user_id,
        entity_id: row.entity_id, entity_kind: row.entity_kind, household_id: row.household_id,
        id: row.id, occurred_at: row.occurred_at, outcome: row.outcome, previous_hash: row.previous_hash });
      expect(row.event_hash).toBe(createHash("sha256").update(canonical).digest("hex"));
    } finally { reader.close(); mutations.close(); writer.close(); }
  });

  it("exposes the grant only through same-origin cookie and CSRF checks", async () => {
    const { path, writer } = database();
    const token = "o".repeat(43);
    const secret = Buffer.alloc(32, 4);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-http', 'owner-a', ?, ?, 1, 100, 4000000000, 100)")
      .run(sessionTokenSha256(token), secret);
    const reader = new SqliteFamilyTimeline(path);
    const mutations = new SqliteFamilyMutations(path);
    const app = createHttpApp({ authenticate: cookieAuthenticator(reader), timeline: reader,
      pages: reader, mutations, expectedOrigin: "http://127.0.0.1:9999" });
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test listener unavailable");
    const url = `http://127.0.0.1:${address.port}/api/v2/care-profiles/profile-a/timeline/days/2030-04-12/access`;
    const body = JSON.stringify({ subjectUserId: "child-a", level: "view" });
    const headers = { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "x-csrf-token": issueCsrfToken("session-http", secret), "sec-fetch-site": "same-origin" };
    try {
      const wrongOrigin = await fetch(url, { method: "POST", body,
        headers: { ...headers, origin: "http://evil.invalid" } });
      expect(wrongOrigin.status).toBe(403);
      const allowed = await fetch(url, { method: "POST", body,
        headers: { ...headers, origin: "http://127.0.0.1:9999" } });
      expect(allowed.status).toBe(201);
      expect((await allowed.json()).eventNo).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      reader.close(); mutations.close(); writer.close();
    }
  });

  it("provisions independent adult and child accounts with single-use expiring invitations", async () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 9);
    const token = "o".repeat(43);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-invite', 'owner-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(token), secret);
    const preflight = { ok: true as const, tokenSha256: sessionTokenSha256(token),
      csrfToken: issueCsrfToken("session-invite", secret) };
    const accounts = new SqliteFamilyAccounts(path);
    const reader = new SqliteFamilyTimeline(path);
    try {
      const adultInvite = accounts.issueInvitation(preflight, "adult", 200);
      const childInvite = accounts.issueInvitation(preflight, "child", 200);
      if (!adultInvite.ok || !childInvite.ok) throw new Error("Expected fictional invitations");
      const adult = await accounts.acceptInvitation({ token: adultInvite.value.token,
        loginName: "Aunt.Example", displayName: "Fictional aunt", password: "a long fictional password", nowSeconds: 201 });
      const child = await accounts.acceptInvitation({ token: childInvite.value.token,
        loginName: "Young.Example", displayName: "Fictional child", password: "another fictional password", nowSeconds: 201 });
      if (!adult.ok || !child.ok) throw new Error("Expected fictional accounts");
      expect(adult.value.memberKind).toBe("adult");
      expect(child.value.memberKind).toBe("child");
      expect(adult.value.userId).not.toBe(child.value.userId);
      expect(await reader.listApprovedDays({ householdId: "family-a", userId: adult.value.userId,
        careProfileId: "profile-a", throughDay: "2030-04-30", limit: 10 })).toEqual([]);
      expect(await accounts.acceptInvitation({ token: adultInvite.value.token,
        loginName: "Other.Example", displayName: "Other", password: "a long fictional password", nowSeconds: 202 }))
        .toEqual({ ok: false, error: "INVITATION_INVALID" });
      expect(await accounts.login({ loginName: "aunt.example", password: "wrong fictional pass", nowSeconds: 203 }))
        .toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await accounts.login({ loginName: "young.example", password: "wrong fictional pass",
          nowSeconds: 203 });
      }
      expect(await accounts.login({ loginName: "young.example", password: "wrong fictional pass",
        nowSeconds: 203 })).toEqual({ ok: false, error: "TRY_LATER" });
      expect(await accounts.login({ loginName: "young.example",
        password: "another fictional password", nowSeconds: 203 }))
        .toEqual({ ok: false, error: "TRY_LATER" });
      const loggedIn = await accounts.login({ loginName: "aunt.example",
        password: "a long fictional password", nowSeconds: 204 });
      expect(loggedIn).toMatchObject({ ok: true, value: { userId: adult.value.userId } });
      expect(accounts.logout({ ok: true, tokenSha256: sessionTokenSha256(adult.value.sessionToken),
        csrfToken: adult.value.csrfToken }, 205)).toEqual({ ok: true, value: null });
      expect((await reader.findByTokenSha256(sessionTokenSha256(adult.value.sessionToken)))?.revokedAt).toBe(205);
      const expired = accounts.issueInvitation(preflight, "adult", 206);
      if (!expired.ok) throw new Error("Expected expiring invitation");
      expect(await accounts.acceptInvitation({ token: expired.value.token,
        loginName: "Late.Example", displayName: "Late", password: "a long fictional password",
        nowSeconds: expired.value.expiresAt })).toEqual({ ok: false, error: "INVITATION_INVALID" });
    } finally { reader.close(); accounts.close(); writer.close(); }
  });

  it("serves invitation acceptance and individual login without exposing session tokens in JSON", async () => {
    const { path, writer } = database();
    const ownerToken = "o".repeat(43);
    const secret = Buffer.alloc(32, 5);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-owner-http', 'owner-a', ?, ?, 1, 100, 4000000000, 100)")
      .run(sessionTokenSha256(ownerToken), secret);
    const reader = new SqliteFamilyTimeline(path);
    const accounts = new SqliteFamilyAccounts(path);
    const app = createHttpApp({ authenticate: cookieAuthenticator(reader), timeline: reader,
      pages: reader, accounts, sessions: reader, expectedOrigin: "http://127.0.0.1:9999" });
    const server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, "127.0.0.1", () => resolve(started));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test listener unavailable");
    const base = `http://127.0.0.1:${address.port}/api/v2/auth`;
    const common = { origin: "http://127.0.0.1:9999", "content-type": "application/json",
      "sec-fetch-site": "same-origin" };
    try {
      const invited = await fetch(`${base}/invitations`, { method: "POST",
        headers: { ...common, cookie: `${SESSION_COOKIE_NAME}=${ownerToken}`,
          "x-csrf-token": issueCsrfToken("session-owner-http", secret) },
        body: JSON.stringify({ memberKind: "adult" }) });
      expect(invited.status).toBe(201);
      const { token } = await invited.json() as { token: string };
      const accepted = await fetch(`${base}/invitations/accept`, { method: "POST", headers: common,
        body: JSON.stringify({ token, loginName: "Sibling.Example", displayName: "Fictional sibling",
          password: "fictional secure password" }) });
      expect(accepted.status).toBe(201);
      expect(accepted.headers.get("set-cookie")).toContain(SESSION_COOKIE_NAME);
      expect(JSON.stringify(await accepted.json())).not.toContain("sessionToken");
      const login = await fetch(`${base}/login`, { method: "POST", headers: common,
        body: JSON.stringify({ loginName: "sibling.example", password: "fictional secure password" }) });
      expect(login.status).toBe(200);
      expect(login.headers.get("set-cookie")).toContain("HttpOnly");
      const loginBody = await login.json() as { userId: string; csrfToken: string };
      expect(loginBody.userId).toBeTruthy();
      expect(loginBody.csrfToken).toMatch(/^v1\./);
      const denied = await fetch(`${base}/login`, { method: "POST",
        headers: { ...common, origin: "http://evil.invalid" },
        body: JSON.stringify({ loginName: "sibling.example", password: "fictional secure password" }) });
      expect(denied.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      reader.close(); accounts.close(); writer.close();
    }
  });

  it("holds a child's fictional note for adult review and publishes one immutable snapshot", async () => {
    const { path, writer } = database();
    const secret = Buffer.alloc(32, 6);
    const ownerToken = "o".repeat(43);
    const childToken = "c".repeat(43);
    const adultToken = "d".repeat(43);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-owner-review', 'owner-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(ownerToken), secret);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-child-review', 'child-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(childToken), secret);
    writer.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, created_at, expires_at, last_seen_at) VALUES ('session-adult-review', 'adult-a', ?, ?, 1, 100, 1000, 100)")
      .run(sessionTokenSha256(adultToken), secret);
    const owner = { ok: true as const, tokenSha256: sessionTokenSha256(ownerToken),
      csrfToken: issueCsrfToken("session-owner-review", secret) };
    const child = { ok: true as const, tokenSha256: sessionTokenSha256(childToken),
      csrfToken: issueCsrfToken("session-child-review", secret) };
    const adult = { ok: true as const, tokenSha256: sessionTokenSha256(adultToken),
      csrfToken: issueCsrfToken("session-adult-review", secret) };
    const mutations = new SqliteFamilyMutations(path);
    const reader = new SqliteFamilyTimeline(path);
    try {
      expect(mutations.grantProfileIntake({ preflight: owner, careProfileId: "profile-a",
        subjectUserId: "child-a", allowed: true, nowSeconds: 200 })).toMatchObject({ ok: true });
      expect(mutations.grantProfileIntake({ preflight: owner, careProfileId: "profile-a",
        subjectUserId: "adult-a", allowed: true, nowSeconds: 200 })).toMatchObject({ ok: true });
      const proposal = mutations.proposeNote({ preflight: child, careProfileId: "profile-a",
        careDay: "2030-04-12", body: "Fictional child observation.", nowSeconds: 201 });
      if (!proposal.ok) throw new Error("Expected fictional proposal");
      const adultProposal = mutations.proposeNote({ preflight: adult, careProfileId: "profile-a",
        careDay: "2030-04-12", body: "Fictional adult observation.", nowSeconds: 201 });
      if (!adultProposal.ok) throw new Error("Expected fictional adult proposal");
      expect(adultProposal.reviewRequestId).toBeNull();
      const pendingNotes = await reader.listPendingNoteReviews({ householdId: "family-a",
        userId: "owner-a", careProfileId: "profile-a" });
      expect(pendingNotes.map((hint) => hint.revisionId).sort())
        .toEqual([proposal.revisionId, adultProposal.revisionId].sort());
      expect(JSON.stringify(pendingNotes)).not.toContain("Fictional adult observation");
      expect(proposal.reviewRequestId).toBeTruthy();
      expect((writer.prepare("SELECT count(*) n FROM review_outbox_events WHERE kind = 'requested'").get() as { n: number }).n).toBe(1);
      const ownerHints = await reader.listPendingChildReviews({ householdId: "family-a",
        userId: "owner-a", careProfileId: "profile-a" });
      expect(ownerHints).toMatchObject([{ id: proposal.reviewRequestId,
        targetCareDay: "2030-04-12" }]);
      expect(JSON.stringify(ownerHints)).not.toContain("Fictional child observation");
      expect(await reader.listPendingChildReviews({ householdId: "family-a",
        userId: "child-a", careProfileId: "profile-a" })).toEqual([]);
      expect((await reader.listApprovedDays({ householdId: "family-a", userId: "owner-a",
        careProfileId: "profile-a", throughDay: "2030-04-30", limit: 10 }))[0]?.statements)
        .toHaveLength(1);
      expect(mutations.reviewNote({ preflight: child, careProfileId: "profile-a",
        revisionId: proposal.revisionId, expectedDayRevision: 1,
        decision: "accepted", nowSeconds: 202 }))
        .toMatchObject({ ok: false, status: 403, error: "FORBIDDEN" });
      expect(mutations.reviewNote({ preflight: owner, careProfileId: "profile-a",
        revisionId: proposal.revisionId, expectedDayRevision: 0,
        decision: "accepted", nowSeconds: 202 }))
        .toMatchObject({ ok: false, status: 409, error: "STALE_REVISION" });
      expect(mutations.reviewNote({ preflight: owner, careProfileId: "profile-a",
        revisionId: proposal.revisionId, expectedDayRevision: 1,
        decision: "accepted", nowSeconds: 202 }))
        .toMatchObject({ ok: true, revision: 2 });
      const published = (await reader.listApprovedDays({ householdId: "family-a", userId: "owner-a",
        careProfileId: "profile-a", throughDay: "2030-04-30", limit: 10 }))[0];
      expect(published?.statements.map((s) => s.text)).toEqual([
        "Fictional family note.", "Fictional child observation.",
      ]);
      expect(published?.revision).toBe(2);
      expect((await reader.listDayVersions({ householdId: "family-a", userId: "owner-a",
        careProfileId: "profile-a", careDay: "2030-04-12" })).map((version) => version.revision))
        .toEqual([2, 1]);
      expect((await reader.readDayVersion({ householdId: "family-a", userId: "owner-a",
        careProfileId: "profile-a", careDay: "2030-04-12", revision: 1 }))?.statements)
        .toHaveLength(1);
      expect(await reader.readDayVersion({ householdId: "family-a", userId: "child-a",
        careProfileId: "profile-a", careDay: "2030-04-12", revision: 1 })).toBeNull();
      expect((writer.prepare("SELECT count(*) n FROM review_outbox_events WHERE kind = 'resolved'").get() as { n: number }).n).toBe(1);
      expect(await reader.listPendingChildReviews({ householdId: "family-a",
        userId: "owner-a", careProfileId: "profile-a" })).toEqual([]);
      expect((writer.prepare("SELECT count(*) n FROM day_snapshots WHERE day_node_id = 'day-a'").get() as { n: number }).n).toBe(2);
    } finally { reader.close(); mutations.close(); writer.close(); }
  });
});
