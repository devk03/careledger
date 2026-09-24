import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { createTimelineMcpServer } from "../src/mcp/server.js";
import type { ApprovedPageRepository, TimelineRepository } from "../src/timeline/types.js";

const profileId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";

async function withClient(
  repository: TimelineRepository,
  householdId: string,
  run: (client: Client) => Promise<void>,
  pages: ApprovedPageRepository = { readApprovedPageChunk: async () => null },
) {
  const server = createTimelineMcpServer({
    scope: { householdId, userId: "fictional-adult" },
    timeline: repository,
    pages,
  });
  const client = new Client({ name: "fictional-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("read-only MCP timeline adapter", () => {
  it("lists only the scoped history tool and returns current cited day data", async () => {
    let calls = 0;
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async (id, family) => id === profileId && family === "family-a",
      listApprovedDays: async ({ householdId }) => {
        expect(householdId).toBe("family-a");
        calls += 1;
        return [{
          id: "fictional-day", careProfileId: profileId, day: "2026-09-18",
          sources: [{
            documentId: "fictional-file", displayName: "fictional-file.pdf",
            uploadedAt: "2026-09-23T12:00:00Z", sourceSha256: "a".repeat(64), pageNumbers: [1],
          }],
          statements: [], revision: 1,
        }];
      },
    };

    await withClient(repository, "family-a", async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "get_approved_source_page", "get_history_through_day", "list_timeline_days",
      ]);
      const result = await client.callTool({
        name: "get_history_through_day",
        arguments: { careProfileId: profileId, throughDay: "2026-09-18" },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content[0];
      expect(content?.type).toBe("text");
      if (content?.type === "text") {
        const history = JSON.parse(content.text);
        expect(history.days[0].sources[0].documentId).toBe("fictional-file");
        expect(history.meaning).toBe("currently_recorded_history");
      }
      const dayList = await client.callTool({
        name: "list_timeline_days",
        arguments: { careProfileId: profileId, throughDay: "2026-09-18" },
      });
      expect(dayList.isError).not.toBe(true);
      const dayListContent = dayList.content[0];
      if (dayListContent?.type === "text") {
        expect(JSON.parse(dayListContent.text).days).toEqual([
          { id: "fictional-day", day: "2026-09-18", fileCount: 1, revision: 1 },
        ]);
      }
    });
    expect(calls).toBe(2);
  });

  it("does not expose another family's timeline", async () => {
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => false,
      listApprovedDays: async () => { throw new Error("Unauthorized list"); },
    };
    await withClient(repository, "family-b", async (client) => {
      const result = await client.callTool({
        name: "get_history_through_day",
        arguments: { careProfileId: profileId, throughDay: "2026-09-18" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Timeline not found" }]);
    });
  });

  it("returns a bounded, explicitly untrusted approved source page", async () => {
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async (id, family) => id === profileId && family === "family-a",
      listApprovedDays: async () => [],
    };
    const pages: ApprovedPageRepository = {
      readApprovedPageChunk: async ({ householdId, documentId: requested, maxChars }) => {
        expect(householdId).toBe("family-a");
        expect(requested).toBe(documentId);
        expect(maxChars).toBe(6_000);
        return {
          documentId, pageNumber: 1, sourceSha256: "a".repeat(64), offset: 0,
          text: "SYNTHETIC RECORD: fictional result is pending.", nextOffset: null,
        };
      },
    };
    await withClient(repository, "family-a", async (client) => {
      const result = await client.callTool({
        name: "get_approved_source_page",
        arguments: { careProfileId: profileId, documentId, pageNumber: 1 },
      });
      expect(result.isError).not.toBe(true);
      const content = result.content[0];
      if (content?.type !== "text") throw new Error("Expected text result");
      const page = JSON.parse(content.text);
      expect(page.sourceTextIsUntrusted).toBe(true);
      expect(page.text).toContain("SYNTHETIC RECORD");
    }, pages);
  });

  it("does not query page content across family boundaries", async () => {
    let reads = 0;
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => false,
      listApprovedDays: async () => [],
    };
    const pages: ApprovedPageRepository = {
      readApprovedPageChunk: async () => { reads += 1; return null; },
    };
    await withClient(repository, "family-b", async (client) => {
      const result = await client.callTool({
        name: "get_approved_source_page",
        arguments: { careProfileId: profileId, documentId, pageNumber: 1 },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "Source page not found" }]);
    }, pages);
    expect(reads).toBe(0);
  });

  it("bounds tool responses instead of flooding the connected agent", async () => {
    const repository: TimelineRepository = {
      profileBelongsToHousehold: async () => true,
      listApprovedDays: async () => [{
        id: "fictional-day", careProfileId: profileId, day: "2026-09-18",
        sources: [],
        statements: [{
          id: "fictional-statement", text: "x".repeat(130_000),
          attribution: "family_note", status: "uncertain",
        }],
        revision: 1,
      }],
    };
    await withClient(repository, "family-a", async (client) => {
      const result = await client.callTool({
        name: "get_history_through_day",
        arguments: { careProfileId: profileId, throughDay: "2026-09-18" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{
        type: "text", text: "Result too large. Request fewer days, then read individual source pages.",
      }]);
    });
  });
});
