import express from "express";
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createDocumentDayRouter } from "../src/http/documentDayRouter.js";

const servers: Server[] = [];
const origin = "https://adeno.example.invalid"; const token = "D".repeat(43);
const headers = { origin, cookie: `__Host-careledger_session=${token}`,
  "x-csrf-token": "fictional-csrf", "content-type": "application/json" };
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function endpoint(writer: Parameters<typeof createDocumentDayRouter>[0]["writer"],
  reviews?: Parameters<typeof createDocumentDayRouter>[0]["reviews"],
  inbox?: Parameters<typeof createDocumentDayRouter>[0]["inbox"]) {
  const app = express(); app.use(createDocumentDayRouter({ expectedOrigin: origin, writer,
    ...(reviews === undefined ? {} : { reviews }), ...(inbox === undefined ? {} : { inbox }) }));
  const server = await new Promise<Server>(resolve => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  servers.push(server); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic endpoint unavailable");
  const base = `http://127.0.0.1:${address.port}/api/v2/care-profiles/profile-a`;
  return { proposal: `${base}/documents/document-a/day-proposals`, review: `${base}/timeline/document-days/revision-a/review`,
    read: `${base}/reviews/document-days/revision-a`, inbox: `${base}/documents/inbox` };
}
const denied = () => ({ ok: false as const, status: 403 as const, error: "FORBIDDEN" as const });
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

it("authenticates paginated inbox reads and validates both cursor fields without trusting query authority", async () => {
  let reads = 0;
  const urls = await endpoint({ proposeDocumentDay: denied, reviewDocumentDay: denied }, undefined, {
    authenticate: async request => request.get("authorization") === "Bearer fictional-owner"
      ? { householdId: "family-a", userId: "owner-a" } : null,
    repository: { listDocumentInbox: async input => {
      reads++; expect(input).toEqual({ householdId: "family-a", userId: "owner-a", careProfileId: "profile-a",
        before: { uploadedAt: 100, documentId: "document-a" } });
      return { documents: [], nextCursor: null };
    } },
  });
  expect((await fetch(urls.inbox)).status).toBe(401); expect(reads).toBe(0);
  const authorized = { authorization: "Bearer fictional-owner" };
  for (const query of ["beforeUploadedAt=100", "beforeDocumentId=document-a", "beforeUploadedAt=-1&beforeDocumentId=document-a",
    "beforeUploadedAt=100&beforeUploadedAt=200&beforeDocumentId=document-a", "beforeUploadedAt=9007199254740992&beforeDocumentId=document-a"]) {
    expect((await fetch(`${urls.inbox}?${query}`, { headers: authorized })).status).toBe(400);
  }
  expect(reads).toBe(0);
  const response = await fetch(`${urls.inbox}?beforeUploadedAt=100&beforeDocumentId=document-a&userId=other&householdId=other`, { headers: authorized });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ documents: [], nextCursor: null }); expect(reads).toBe(1);
});

it("requires cookie, origin and CSRF preflight before parsing either mutation body", async () => {
  const mustNotWrite = () => { throw new Error("Must not write"); };
  const urls = await endpoint({ proposeDocumentDay: mustNotWrite, reviewDocumentDay: mustNotWrite });
  for (const url of [urls.proposal, urls.review]) for (const [candidate, status] of [
    [{ origin }, 401], [{ ...headers, origin: "https://attacker.invalid" }, 403], [{ ...headers, "x-csrf-token": "" }, 403],
  ] as const) {
    const response = await fetch(url, { method: "POST", headers: candidate, body: "malformed" });
    expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

it("returns private review detail only through authenticated scope, with generic absence and failure responses", async () => {
  const detail = { revisionId: "revision-a", careDay: "2030-04-12", documentId: "document-a",
    displayName: "Independently invented original.png", sourceSha256: "a".repeat(64), pageCount: 1,
    authorLabel: "Invented author", createdAt: "2030-04-13T12:00:00.000Z", expectedDayRevision: 2, state: "proposed" as const };
  let mode: "allow" | "deny" | "error" = "allow"; let reads = 0;
  const urls = await endpoint({ proposeDocumentDay: denied, reviewDocumentDay: denied }, {
    authenticate: async request => request.get("authorization") === "Bearer fictional-reviewer"
      ? { householdId: "family-a", userId: "reviewer-a" } : null,
    repository: { readPendingDocumentDay: async input => {
      reads++; expect(input).toEqual({ householdId: "family-a", userId: "reviewer-a", careProfileId: "profile-a", revisionId: "revision-a" });
      if (mode === "error") throw new Error("Invented private storage details");
      return mode === "allow" ? detail : null;
    } },
  });
  expect((await fetch(urls.read)).status).toBe(401); expect(reads).toBe(0);
  const authorized = { authorization: "Bearer fictional-reviewer" };
  const response = await fetch(`${urls.read}?householdId=other&userId=owner`, { headers: authorized });
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(detail);
  mode = "deny"; const absent = await fetch(urls.read, { headers: authorized });
  expect(absent.status).toBe(404); expect(await absent.json()).toEqual({ error: "NOT_FOUND" });
  mode = "error"; const unavailable = await fetch(urls.read, { headers: authorized });
  expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: "DOCUMENT_WORKFLOW_UNAVAILABLE" });
});

it("uses route scope and server-derived session authority for explicit proposal and review", async () => {
  const preflight = { ok: true, csrfToken: "fictional-csrf", tokenSha256: createHash("sha256").update(token).digest("hex") };
  const urls = await endpoint({ proposeDocumentDay: input => {
    expect(input).toEqual({ preflight, careProfileId: "profile-a", documentId: "document-a", careDay: "2030-04-12" });
    return { ok: true, placementId: "placement-a", revisionId: "revision-a", reviewRequestId: null };
  }, reviewDocumentDay: input => {
    expect(input).toEqual({ preflight, careProfileId: "profile-a", revisionId: "revision-a",
      expectedDayRevision: 2, decision: "accepted", reason: "Checked original" });
    return { ok: true, snapshotId: "snapshot-a", revision: 3 };
  } });
  expect((await post(urls.proposal, { careDay: "2030-04-12" })).status).toBe(201);
  const response = await post(urls.review, { expectedDayRevision: 2, decision: "accepted", reason: " Checked original " });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, snapshotId: "snapshot-a", revision: 3 });
});

it("denies invalid dates, decisions, revisions, spoofed fields, compressed and oversized bodies before writing", async () => {
  const mustNotWrite = () => { throw new Error("Unexpected write"); };
  const urls = await endpoint({ proposeDocumentDay: mustNotWrite, reviewDocumentDay: mustNotWrite });
  for (const body of [null, [], {}, { careDay: "2030-02-30" }, { careDay: "2030-04-12", userId: "owner" }])
    expect((await post(urls.proposal, body)).status).toBe(400);
  for (const body of [{ expectedDayRevision: -1, decision: "accepted" }, { expectedDayRevision: 1.5, decision: "accepted" },
    { expectedDayRevision: 0, decision: "automatic" }, { expectedDayRevision: 0, decision: "accepted", reason: " " }])
    expect((await post(urls.review, body)).status).toBe(400);
  expect((await post(urls.proposal, { careDay: "x".repeat(5000) })).status).toBe(413);
  expect((await fetch(urls.proposal, { method: "POST", headers: { ...headers, "content-encoding": "gzip" }, body: "fictional" })).status).toBe(415);
});

it("preserves transaction denials and stale conflicts while redacting unexpected storage errors", async () => {
  const urls = await endpoint({ proposeDocumentDay: denied,
    reviewDocumentDay: () => ({ ok: false, status: 409, error: "STALE_REVISION" }) });
  expect((await post(urls.proposal, { careDay: "2030-04-12" })).status).toBe(403);
  const stale = await post(urls.review, { expectedDayRevision: 0, decision: "accepted" });
  expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: "STALE_REVISION" });
  const broken = await endpoint({ proposeDocumentDay: () => { throw new Error("Invented private storage details"); }, reviewDocumentDay: denied });
  const unavailable = await post(broken.proposal, { careDay: "2030-04-12" });
  expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: "DOCUMENT_WORKFLOW_UNAVAILABLE" });
});
