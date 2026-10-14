import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createAuthorizedTimelineMcpServer } from "../src/mcp/authorizedTimeline.js";
import type { AuthorizedScope } from "../src/timeline/types.js";

const profileId = "11111111-1111-4111-8111-111111111111";
const scope = { householdId: "invented-family", userId: "invented-adult" };
async function fixture() {
  let identity: AuthorizedScope | null = { ...scope };
  let reads = 0;
  let broken = false;
  const server = await createAuthorizedTimelineMcpServer({ authorize: async () => identity,
    timeline: {
      profileBelongsToHousehold: async () => { reads++; return true; },
      listApprovedDays: async input => {
        expect(input).toMatchObject(scope);
        reads++;
        if (broken) throw new Error("fictional sensitive source text and SQL diagnostic");
        return [{ id: "invented-day", careProfileId: profileId, day: "2030-04-12", revision: 1,
          statements: [{ id: "invented-note", text: "Independently invented observation.",
            attribution: "family_note", status: "uncertain" }], sources: [] }];
      },
    }, pages: { readApprovedPageChunk: async () => null },
    profiles: { listVisibleCareProfiles: async () => { reads++; return [{ id: profileId, preferredName: "Invented person" }]; } },
  });
  const client = new Client({ name: "invented-authorized-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, reads: () => reads, setIdentity: (value: AuthorizedScope | null) => { identity = value; },
    breakStorage: () => { broken = true; }, close: async () => { await client.close(); await server.close(); } };
}

it("exposes read-only tools and an accurate private connection profile", async () => {
  const state = await fixture();
  try {
    expect((await state.client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
      "get_approved_source_page", "get_connection_profile", "get_history_through_day", "list_care_profiles", "list_timeline_days",
    ]);
    const result = await state.client.callTool({ name: "get_connection_profile", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("trusted_server_readable");
    expect(JSON.stringify(result)).not.toContain("sessionToken");
  } finally { await state.close(); }
});

it("denies subsequent calls after revocation without reading private repositories", async () => {
  const state = await fixture();
  try {
    expect((await state.client.callTool({ name: "get_history_through_day",
      arguments: { careProfileId: profileId, throughDay: "2030-04-12" } })).isError).not.toBe(true);
    const priorReads = state.reads();
    state.setIdentity(null);
    for (const name of ["get_connection_profile", "list_care_profiles", "get_history_through_day"]) {
      const result = await state.client.callTool({ name, arguments: name === "get_history_through_day"
        ? { careProfileId: profileId, throughDay: "2030-04-12" } : {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("Independently invented observation");
    }
    expect(state.reads()).toBe(priorReads);
  } finally { await state.close(); }
});

it("rejects identity switching on an already-open connection", async () => {
  const state = await fixture();
  try {
    state.setIdentity({ ...scope, householdId: "other-family" });
    const result = await state.client.callTool({ name: "list_care_profiles", arguments: {} });
    expect(result.isError).toBe(true); expect(state.reads()).toBe(0);
  } finally { await state.close(); }
});

it("redacts storage failures instead of returning source text or diagnostics", async () => {
  const state = await fixture();
  try {
    state.breakStorage();
    const result = await state.client.callTool({ name: "get_history_through_day",
      arguments: { careProfileId: profileId, throughDay: "2030-04-12" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fictional sensitive source");
    expect(JSON.stringify(result)).not.toContain("SQL diagnostic");
  } finally { await state.close(); }
});

it("rejects a revoked connection between profile lookup and the history read", async () => {
  let active = true;
  let dayReads = 0;
  const server = await createAuthorizedTimelineMcpServer({ authorize: async () => active ? scope : null,
    timeline: { profileBelongsToHousehold: async () => { active = false; return true; },
      listApprovedDays: async () => { dayReads++; return []; } },
    pages: { readApprovedPageChunk: async () => null } });
  const client = new Client({ name: "invented-racing-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport); await client.connect(clientTransport);
    const result = await client.callTool({ name: "get_history_through_day",
      arguments: { careProfileId: profileId, throughDay: "2030-04-12" } });
    expect(result.isError).toBe(true); expect(dayReads).toBe(0);
  } finally { await client.close(); await server.close(); }
});

it("does not construct a record connection without initial authorization", async () => {
  await expect(createAuthorizedTimelineMcpServer({ authorize: async () => null,
    timeline: { profileBelongsToHousehold: async () => false, listApprovedDays: async () => [] },
    pages: { readApprovedPageChunk: async () => null } })).rejects.toThrow("AUTH_REQUIRED");
});
