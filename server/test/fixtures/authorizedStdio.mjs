import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAuthorizedTimelineMcpServer } from "../../dist/mcp/authorizedTimeline.js";
import { PrivateAgentGrantStore } from "../../dist/auth/privateAgentGrants.js";

// Test-only fixture, excluded from production Docker context. Invents all data.
if (process.env.ADENO_FICTIONAL_STDIO_TEST !== "1") process.exit(1);
const profileId = "11111111-1111-4111-8111-111111111111";
let active = true;
const grantRoot = process.env.ADENO_FICTIONAL_GRANT_ROOT;
const grants = grantRoot ? new PrivateAgentGrantStore(grantRoot) : null;
const sessions = { findByTokenSha256: async hash => hash === "a".repeat(64) ? {
  sessionId: "invented-session", userId: "invented-adult", householdId: "invented-family",
  userStatus: "active", sessionAuthVersion: 1, userAuthVersion: 1, revokedAt: null,
  expiresAt: Math.floor(Date.now() / 1000) + 7200, csrfSecret: Buffer.alloc(32, 3),
} : null };
const server = await createAuthorizedTimelineMcpServer({
  authorize: async () => grants ? grants.authorize(process.env.ADENO_FICTIONAL_GRANT_ID ?? "", sessions)
    : active ? { userId: "invented-adult", householdId: "invented-family" } : null,
  timeline: {
    profileBelongsToHousehold: async () => true,
    listApprovedDays: async () => [{ id: "invented-day", careProfileId: profileId,
      day: "2030-04-12", revision: 1, statements: [], sources: [{ documentId: "22222222-2222-4222-8222-222222222222",
        displayName: "Invented report", uploadedAt: "2030-04-13T12:00:00Z", sourceSha256: "a".repeat(64), pageNumbers: [1] }] }],
  }, pages: { readApprovedPageChunk: async input => ({ documentId: input.documentId,
    pageNumber: input.pageNumber, sourceSha256: "a".repeat(64), offset: input.offset,
    text: "Wholly invented source page.", nextOffset: null }) },
  profiles: { listVisibleCareProfiles: async () => [{ id: profileId, preferredName: "Invented person" }] },
});
process.on("SIGUSR2", () => { active = false; process.stderr.write("fictional grant revoked\n"); });
process.stdin.once("end", () => { void server.close(); });
await server.connect(new StdioServerTransport());
