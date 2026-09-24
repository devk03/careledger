import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteFamilyTimeline, IncompatibleFamilyTimelineDatabase } from "../src/storage/sqliteFamilyTimeline.js";

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

function database(): { path: string; writer: Database.Database } {
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
  writer.prepare("INSERT INTO documents (id, care_profile_id, source_sha256, original_display_name, scan_verdict, status, uploaded_by, uploaded_at) VALUES ('document-a', 'profile-a', ?, 'fictional.pdf', 'clean', 'complete', 'owner-a', 100)").run(documentHash);
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
  chmodSync(path, 0o600);
  return { path, writer };
}

describe("fictional v7 family timeline", () => {
  it("separates day access from original-source access and checks revocations afresh", async () => {
    const { path, writer } = database();
    const reader = new SqliteFamilyTimeline(path);
    const input = { householdId: "family-a", careProfileId: "profile-a", throughDay: "2030-04-30", limit: 10 };
    try {
      const owner = await reader.listApprovedDays({ ...input, userId: "owner-a" });
      expect(owner[0]?.sources[0]?.displayName).toBe("fictional.pdf");
      expect(owner[0]?.statements[0]?.text).toBe("Fictional family note.");
      const adult = await reader.listApprovedDays({ ...input, userId: "adult-a" });
      expect(adult[0]?.sources).toEqual([]);
      expect(adult[0]?.statements).toHaveLength(1);
      expect(await reader.readApprovedPageChunk({ ...input, userId: "adult-a", documentId: "document-a", pageNumber: 1, offset: 0, maxChars: 6000 })).toBeNull();
      expect(await reader.listApprovedDays({ ...input, userId: "child-a" })).toEqual([]);
      writer.prepare("INSERT INTO document_access_events (id, care_profile_id, document_id, subject_user_id, event_no, allowed, actor_user_id, occurred_at) VALUES ('grant-source-a', 'profile-a', 'document-a', 'adult-a', 1, 1, 'owner-a', 103)").run();
      expect((await reader.listApprovedDays({ ...input, userId: "adult-a" }))[0]?.sources).toHaveLength(1);
      expect((await reader.readApprovedPageChunk({ ...input, userId: "adult-a", documentId: "document-a", pageNumber: 1, offset: 0, maxChars: 20 }))?.text).toBe(pageText.slice(0, 20));
      writer.prepare("INSERT INTO document_access_events (id, care_profile_id, document_id, subject_user_id, event_no, allowed, actor_user_id, occurred_at) VALUES ('revoke-source-a', 'profile-a', 'document-a', 'adult-a', 2, 0, 'owner-a', 104)").run();
      expect((await reader.listApprovedDays({ ...input, userId: "adult-a" }))[0]?.sources).toEqual([]);
      writer.prepare("INSERT INTO day_access_events (id, care_profile_id, care_day, subject_user_id, event_no, level, actor_user_id, occurred_at) VALUES ('revoke-day-a', 'profile-a', '2030-04-12', 'adult-a', 2, 'none', 'owner-a', 105)").run();
      expect(await reader.listApprovedDays({ ...input, userId: "adult-a" })).toEqual([]);
    } finally { reader.close(); writer.close(); }
  });

  it("rejects an altered migration ledger", () => {
    const { path, writer } = database();
    writer.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 7").run("0".repeat(64));
    writer.close();
    expect(() => new SqliteFamilyTimeline(path)).toThrow(IncompatibleFamilyTimelineDatabase);
  });
});
