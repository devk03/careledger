import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import type { NoteReviewDetail, NoteReviewRepository } from "../src/timeline/types.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
});

async function endpoint(noteReviews: NoteReviewRepository, allowInvitations = true) {
  const app = createHttpApp({
    authenticate: async request => request.get("authorization") === "Bearer fictional-reviewer"
      ? { householdId: "family-a", userId: "reviewer-a" } : null,
    timeline: { profileBelongsToHousehold: async () => true, listApprovedDays: async () => [] },
    pages: { readApprovedPageChunk: async () => null }, noteReviews, allowInvitations,
  });
  const server = await new Promise<Server>(resolve => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test port unavailable");
  return `http://127.0.0.1:${address.port}/api/v2/care-profiles/profile-a/reviews/notes/revision-a`;
}

const proposed: NoteReviewDetail = {
  revisionId: "revision-a", careDay: "2030-04-12", body: "An independently invented note.",
  authorLabel: "Fictional contributor", createdAt: "2030-04-13T12:00:00.000Z",
  expectedDayRevision: 2, attribution: "family_note", state: "proposed",
};
const headers = { authorization: "Bearer fictional-reviewer" };

describe("private note review HTTP", () => {
  it("blocks invitation creation and acceptance in the private production mode", async () => {
    const url = await endpoint({ readPendingNote: async () => null }, false);
    const base = new URL(url).origin;
    for (const path of ["/api/v2/auth/invitations", "/api/v2/auth/invitations/accept"]) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${base}${path}`, { method, headers });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "NOT_FOUND" });
      }
    }
  });

  it("requires authentication before reading any proposal", async () => {
    const url = await endpoint({ readPendingNote: async () => {
      throw new Error("Unauthenticated reads must not reach private storage");
    } });
    const response = await fetch(url);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "AUTH_REQUIRED" });
  });

  it("returns a proposed note and current revision for explicit human review", async () => {
    const url = await endpoint({ readPendingNote: async input => {
      expect(input).toEqual({ householdId: "family-a", userId: "reviewer-a",
        careProfileId: "profile-a", revisionId: "revision-a" });
      return proposed;
    } });
    const response = await fetch(`${url}?userId=owner&householdId=other`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ note: proposed });
  });

  it("uses the same not-found response for absent and unauthorized proposals", async () => {
    const url = await endpoint({ readPendingNote: async () => null });
    for (const candidate of [url, url.replace("revision-a", "unknown")]) {
      const response = await fetch(candidate, { headers });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    }
  });

  it("rechecks access for every read instead of retaining proposal content", async () => {
    let allowed = true;
    const url = await endpoint({ readPendingNote: async () => allowed ? proposed : null });
    expect((await fetch(url, { headers })).status).toBe(200);
    allowed = false;
    const denied = await fetch(url, { headers });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(proposed.body);
  });

  it("does not add proposals to ordinary approved history", async () => {
    const url = await endpoint({ readPendingNote: async () => {
      throw new Error("History must not read private proposals");
    } });
    const history = url.replace("reviews/notes/revision-a", "timeline/history?through=2030-04-12");
    const response = await fetch(history, { headers });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.days).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(proposed.body);
  });
});
