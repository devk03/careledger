import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";
import { PrivateAgentGrantStore } from "../src/auth/privateAgentGrants.js";

it.each([{ args: [] }, { args: ["../private-file"] }, { args: ["a".repeat(32), "extra"] }])(
  "fails closed without valid production connection arguments: %j", async ({ args }) => {
    const run = promisify(execFile);
    let failure: unknown;
    try {
      await run(process.execPath, [fileURLToPath(new URL("../dist/runPrivateMcp.js", import.meta.url)), ...args],
        { env: { ADENO_MCP_TRANSPORT: "ssh-stdio" }, timeout: 5000 });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 1, stdout: "" });
    const stderr = (failure as { stderr: string }).stderr;
    expect(stderr).toContain("adeno MCP connection unavailable");
    expect(stderr).not.toContain("private-file");
    expect(stderr).not.toContain("Error:");
  });

it("initializes a real stdio client, reads cited fixtures and denies the next call after revocation", async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/authorizedStdio.mjs", import.meta.url))],
    env: { ADENO_FICTIONAL_STDIO_TEST: "1" }, stderr: "pipe" });
  const client = new Client({ name: "invented-real-stdio-client", version: "0.1.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("get_connection_profile");
    const history = await client.callTool({ name: "get_history_through_day", arguments: {
      careProfileId: "11111111-1111-4111-8111-111111111111", throughDay: "2030-04-12" } });
    expect(history.isError).not.toBe(true);
    expect(JSON.stringify(history)).toContain("Invented report");
    const page = await client.callTool({ name: "get_approved_source_page", arguments: {
      careProfileId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222", pageNumber: 1 } });
    expect(page.isError).not.toBe(true);
    expect(JSON.stringify(page)).toContain("Wholly invented source page");
    expect(JSON.stringify(page)).toContain("sourceTextIsUntrusted");
    const revoked = new Promise<void>(resolve => {
      transport.stderr!.once("data", () => resolve());
    });
    if (!transport.pid) throw new Error("Missing owned test process");
    process.kill(transport.pid, "SIGUSR2"); await revoked;
    expect((await client.callTool({ name: "get_connection_profile", arguments: {} })).isError).toBe(true);
  } finally { await client.close(); }
});

it("observes durable grant revocation across a real stdio process boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-stdio-grants-"));
  const store = new PrivateAgentGrantStore(root);
  const owner = { userId: "invented-adult", householdId: "invented-family", sessionId: "invented-session",
    sessionTokenSha256: "a".repeat(64), expiresAt: Math.floor(Date.now() / 1000) + 7200 };
  const grant = await store.issue(owner);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/authorizedStdio.mjs", import.meta.url))],
    env: { ADENO_FICTIONAL_STDIO_TEST: "1", ADENO_FICTIONAL_GRANT_ROOT: root,
      ADENO_FICTIONAL_GRANT_ID: grant.grantId }, stderr: "pipe" });
  const client = new Client({ name: "invented-durable-stdio-client", version: "0.1.0" });
  try {
    await client.connect(transport);
    expect((await client.callTool({ name: "get_connection_profile", arguments: {} })).isError).not.toBe(true);
    expect(await store.revoke(grant.grantId, owner)).toBe(true);
    const result = await client.callTool({ name: "get_connection_profile", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(owner.sessionTokenSha256);
  } finally { await client.close(); }
});
