import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";

import { createHttpApp } from "../src/http/app.js";
import type { ApprovedPageRepository, TimelineRepository } from "../src/timeline/types.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function endpoint(
  repository: TimelineRepository,
  pages: ApprovedPageRepository = { readApprovedPageChunk: async () => null },
) {
  const app = createHttpApp({
    authenticate: async (request) => request.headers.authorization === "Bearer fictional-member"
      ? { householdId: "family-a", userId: "adult-a" }
      : null,
    timeline: repository,
    pages,
  });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  return `http://127.0.0.1:${address.port}/api/v2/care-profiles/person-a/timeline/history?through=2026-09-18`;
}

describe("Express history route", () => {
  it("requires authentication and hides other families", async () => {
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => false,
      listApprovedDays: async () => { throw new Error("must not list unauthorized data"); },
    };
    const url = await endpoint(repository);
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { authorization: "Bearer fictional-member" } });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns source-linked sparse days without HTTP caching", async () => {
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => true,
      listApprovedDays: async ({ householdId, throughDay }) => {
        expect(householdId).toBe("family-a");
        expect(throughDay).toBe("2026-09-18");
        return [{
          id: "fictional-day", careProfileId: "person-a", day: "2026-09-18",
          sources: [{
            documentId: "fictional-report", displayName: "fictional-report.pdf",
            uploadedAt: "2026-09-23T12:00:00Z", sourceSha256: "f".repeat(64), pageNumbers: [1],
          }],
          statements: [], revision: 1,
        }];
      },
    };
    const response = await fetch(await endpoint(repository), {
      headers: { authorization: "Bearer fictional-member" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json();
    expect(result.days[0].day).toBe("2026-09-18");
    expect(result.days[0].sources[0].documentId).toBe("fictional-report");
    expect(result.meaning).toBe("currently_recorded_history");
  });

  it("uses the same scoped history for the day-list endpoint", async () => {
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => true,
      listApprovedDays: async () => [{
        id: "fictional-day", careProfileId: "person-a", day: "2026-09-18",
        sources: [
          { documentId: "a", displayName: "a.pdf", uploadedAt: "2026-09-19T10:00:00Z", sourceSha256: "a".repeat(64), pageNumbers: [1] },
          { documentId: "b", displayName: "b.pdf", uploadedAt: "2026-09-20T10:00:00Z", sourceSha256: "b".repeat(64), pageNumbers: [1] },
        ],
        statements: [], revision: 1,
      }],
    };
    const url = (await endpoint(repository)).replace("/timeline/history?", "/timeline/days?");
    const response = await fetch(url, { headers: { authorization: "Bearer fictional-member" } });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.days).toEqual([{ id: "fictional-day", day: "2026-09-18", fileCount: 2, revision: 1 }]);
  });

  it("does not serve an unapproved or cross-family source page", async () => {
    let pageReads = 0;
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => false,
      listApprovedDays: async () => [],
    };
    const pages: ApprovedPageRepository = {
      readApprovedPageChunk: async () => { pageReads += 1; return null; },
    };
    const url = (await endpoint(repository, pages)).replace(
      "/timeline/history?through=2026-09-18", "/documents/fictional-document/pages/1",
    );
    const response = await fetch(url, { headers: { authorization: "Bearer fictional-member" } });
    expect(response.status).toBe(404);
    expect(pageReads).toBe(0);
  });
});
