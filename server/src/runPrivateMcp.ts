import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { PrivateAgentGrantStore } from "./auth/privateAgentGrants.js";
import { createAuthorizedTimelineMcpServer } from "./mcp/authorizedTimeline.js";
import { privatePilotConfig } from "./privatePilotConfig.js";
import { SqliteFamilyTimeline } from "./storage/sqliteFamilyTimeline.js";

// Launch through authenticated SSH, with a browser-approved, nonsecret grant ID.
// Never opens a network listener, issues a grant, writes a DB or prints credentials.
process.umask(0o077);
try {
  if (process.env.ADENO_MCP_TRANSPORT !== "ssh-stdio") throw new Error("Explicit transport required");
  const id = process.argv[2];
  if (!id || !/^[0-9a-f]{32}$/.test(id) || process.argv.length !== 3) throw new Error("Grant required");
  const config = privatePilotConfig(process.env);
  const repository = new SqliteFamilyTimeline(config.databasePath);
  try {
    const grants = new PrivateAgentGrantStore(join(config.secretsDirectory, "agent-grants"));
    const server = await createAuthorizedTimelineMcpServer({
      authorize: async () => {
        const scope = await grants.authorize(id, repository);
        return scope && await repository.isActiveAdult(scope) ? scope : null;
      }, timeline: repository, pages: repository, profiles: repository });
    const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 256 * 1024 });
    let closing = false;
    const lifetime = setTimeout(() => { void shutdown(); }, 3600 * 1000);
    lifetime.unref();
    async function shutdown() {
      if (closing) return;
      closing = true; clearTimeout(lifetime);
      try { await server.close(); } finally { repository.close(); }
    }
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
    process.stdin.once("end", () => { void shutdown(); });
    await server.connect(transport);
  } catch {
    repository.close(); throw new Error("Connection unavailable");
  }
} catch {
  process.stderr.write("adeno MCP connection unavailable; approve a current private connection in the browser.\n");
  process.exitCode = 1;
}
