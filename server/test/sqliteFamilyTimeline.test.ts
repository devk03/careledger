import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { cookieAuthenticator, issueCsrfToken, SESSION_COOKIE_NAME, sessionTokenSha256 } from "../src/auth/cookieSession.js";
import { SqliteFamilyAccounts } from "../src/auth/familyAccounts.js";
import { createHttpApp } from "../src/http/app.js";
import { SqliteFamilyTimeline, IncompatibleFamilyTimelineDatabase } from "../src/storage/sqliteFamilyTimeline.js";
import { SqliteFamilyMutations } from "../src/storage/sqliteFamilyMutations.js";

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
