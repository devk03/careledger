import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { Server } from "node:http";
import { expect, it } from "vitest";

import { createHttpApp } from "../src/http/app.js";
import { createTimelineMcpServer } from "../src/mcp/server.js";
import type { ApprovedPageRepository, TimelineDay, TimelineRepository } from "../src/timeline/types.js";

const profileId = "33333333-3333-4333-8333-333333333333";
const firstDocumentId = "44444444-4444-4444-8444-444444444444";
const laterDocumentId = "55555555-5555-4555-8555-555555555555";

function source(documentId: string, uploadedAt: string) {
  return {
    documentId,
    displayName: `fictional-${documentId.slice(0, 4)}.pdf`,
    uploadedAt,
    sourceSha256: documentId[0]!.repeat(64),
    pageNumbers: [1],
  };
}

it("uses one fresh, authorized history across HTTP and MCP", async () => {
  const days: TimelineDay[] = [
    {
      id: "fictional-older-day", careProfileId: profileId, day: "2030-04-09", revision: 1,
      sources: [source(firstDocumentId, "2030-04-10T10:00:00Z")], statements: [],
    },
    {
      id: "fictional-selected-day", careProfileId: profileId, day: "2030-04-12", revision: 1,
      sources: [source(laterDocumentId, "2030-04-13T10:00:00Z")], statements: [],
    },
    {
      id: "fictional-future-day", careProfileId: profileId, day: "2030-04-16", revision: 1,
      sources: [source("66666666-6666-4666-8666-666666666666", "2030-04-17T10:00:00Z")], statements: [],
    },
  ];
  const timeline: TimelineRepository = {
    profileBelongsToHousehold: async (id, household) => id === profileId && household === "fictional-family-a",
    listApprovedDays: async ({ householdId, userId, careProfileId, throughDay, beforeDay, limit }) => {
      expect(householdId).toBe("fictional-family-a");
      expect(userId).toBe("fictional-adult-a");
      expect(careProfileId).toBe(profileId);
      return days
        .filter((day) => day.day <= throughDay && (beforeDay === undefined || day.day < beforeDay))
        .sort((left, right) => right.day.localeCompare(left.day))
        .slice(0, limit);
    },
  };
  const pages: ApprovedPageRepository = { readApprovedPageChunk: async () => null };
  const app = createHttpApp({
    timeline,
    pages,
    authenticate: async (request) => request.headers.authorization === "Bearer fictional-family-a"
      ? { householdId: "fictional-family-a", userId: "fictional-adult-a" }
      : { householdId: "fictional-family-b", userId: "fictional-adult-b" },
  });
  const httpServer = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("Test listener unavailable");
  const url = `http://127.0.0.1:${address.port}/api/v2/care-profiles/${profileId}/timeline/history?through=2030-04-12&from=2030-04-12`;

  const mcpServer = createTimelineMcpServer({
    scope: { householdId: "fictional-family-a", userId: "fictional-adult-a" },
    timeline,
    pages,
  });
  const client = new Client({ name: "fictional-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const httpFirst = await fetch(url, { headers: { authorization: "Bearer fictional-family-a" } });
    expect(httpFirst.status).toBe(200);
    const firstHistory = await httpFirst.json();
    expect(firstHistory.days.map((day: TimelineDay) => day.day)).toEqual(["2030-04-12", "2030-04-09"]);
    expect(firstHistory.focusFromDay).toBe("2030-04-12");

    const mcpFirst = await client.callTool({
      name: "get_history_through_day",
      arguments: { careProfileId: profileId, throughDay: "2030-04-12", focusFromDay: "2030-04-12" },
    });
    const block = mcpFirst.content[0];
    if (block?.type !== "text") throw new Error("Expected text block");
    expect(JSON.parse(block.text)).toEqual(firstHistory);

    // A new upload about an older care day changes the next read; no summary cache exists.
    days[0]!.sources.push(source("77777777-7777-4777-8777-777777777777", "2030-04-20T10:00:00Z"));
    const httpAgain = await fetch(url, { headers: { authorization: "Bearer fictional-family-a" } });
    expect((await httpAgain.json()).days[1].sources).toHaveLength(2);
    const mcpAgain = await client.callTool({
      name: "get_history_through_day",
      arguments: { careProfileId: profileId, throughDay: "2030-04-12" },
    });
    const secondBlock = mcpAgain.content[0];
    if (secondBlock?.type !== "text") throw new Error("Expected text block");
    expect(JSON.parse(secondBlock.text).days[1].sources).toHaveLength(2);

    const denied = await fetch(url, { headers: { authorization: "Bearer fictional-family-b" } });
    expect(denied.status).toBe(404);
  } finally {
    await client.close();
    await mcpServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
