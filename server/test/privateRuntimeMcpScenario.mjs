// Operator-run SDK transport check against the synthetic Hermes deployment.
// This does not count as acceptance in an actual AI application.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [container, grantId, careProfileId, documentId] = process.argv.slice(2);
assert.match(container ?? "", /^adeno-synthetic-app-[0-9]+$/);
assert.match(grantId ?? "", /^[0-9a-f]{32}$/);
for (const id of [careProfileId, documentId]) assert.match(id ?? "", /^[0-9a-f-]{36}$/);
const ssh = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "hermes"];
const remote = ["sudo", "-n", "docker", "exec", "-i", "--env", "ADENO_MCP_TRANSPORT=ssh-stdio",
  container, "node", "server/dist/runPrivateMcp.js", grantId];
const transport = new StdioClientTransport({ command: "ssh", args: [...ssh, ...remote], stderr: "pipe" });
const client = new Client({ name: "adeno-synthetic-hermes-sdk-acceptance", version: "0.1.0" });
const deadline = setTimeout(() => { void client.close(); process.exitCode = 1; }, 120_000);
try {
  await client.connect(transport);
  const connection = await client.callTool({ name: "get_connection_profile", arguments: {} });
  assert.notEqual(connection.isError, true);
  const metadata = JSON.parse(connection.content.find(item => item.type === "text").text);
  assert.equal(metadata.storagePrivacy, "trusted_server_readable");
  assert.equal(metadata.approvedSourceImages, true);
  const history = await client.callTool({ name: "get_history_through_day", arguments: { careProfileId, throughDay: "2030-04-12" } });
  assert.notEqual(history.isError, true);
  const day = JSON.parse(history.content.find(item => item.type === "text").text).days[0];
  assert.equal(day.revision, 2); assert.equal(day.sources[0].documentId, documentId);
  const result = await client.callTool({ name: "get_approved_source_image", arguments: { careProfileId, documentId } });
  assert.notEqual(result.isError, true);
  const image = result.content.find(item => item.type === "image");
  const citation = JSON.parse(result.content.find(item => item.type === "text").text);
  assert.equal(citation.sourceSha256, day.sources[0].sourceSha256);
  assert.equal(createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex"), citation.rendition.sha256);
  assert.equal(citation.sourceWidth, 240); assert.equal(citation.sourceHeight, 160);
  const hidden = await client.callTool({ name: "get_approved_source_image", arguments: {
    careProfileId: "00000000-0000-4000-8000-000000000001", documentId } });
  assert.equal(hidden.isError, true);
  const child = execFile("ssh", [...ssh, "sudo", "-n", "docker", "exec", "-i", "--env",
    "ADENO_SYNTHETIC_SCENARIO=disconnect", "--workdir", "/app/server", container, "node", "--input-type=module"],
  { timeout: 60_000, maxBuffer: 16 * 1024 });
  child.stdin.end(readFileSync(new URL("./privateRuntimeScenario.mjs", import.meta.url)));
  await new Promise((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error("Disconnect scenario failed"))));
  const denied = await client.callTool({ name: "get_approved_source_image", arguments: { careProfileId, documentId } });
  assert.equal(denied.isError, true);
  assert.equal(denied.content.some(item => item.type === "image"), false);
  console.log(JSON.stringify({ synthetic: true, sshStdio: true, databaseAuthorizedHistory: true,
    originalAndRenditionVerified: true, outsideProfileDenied: true, sameConnectionRevocationDenied: true }));
} finally { clearTimeout(deadline); await client.close(); }
