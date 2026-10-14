import { afterEach, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { AGENT_CONSENT, createPrivateAgentRouter } from "../src/http/privateAgentRouter.js";
import type { SqliteFamilyMutations } from "../src/storage/sqliteFamilyMutations.js";
import type { PrivateAgentGrantStore } from "../src/auth/privateAgentGrants.js";

const owner = { userId: "invented-adult", householdId: "invented-family", sessionId: "invented-session",
  sessionTokenSha256: "a".repeat(64), expiresAt: 4000000000 };
const headers = { origin: "https://adeno.example.invalid", "content-type": "application/json",
  cookie: `__Host-careledger_session=${"a".repeat(43)}`, "x-csrf-token": "invented-csrf" };
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function endpoint(authority: Pick<SqliteFamilyMutations, "authorizeAgentConnection">,
  grants: Pick<PrivateAgentGrantStore, "issue" | "revoke">) {
  const app = express(); app.use(createPrivateAgentRouter({ expectedOrigin: headers.origin, authority, grants }));
  const server = await new Promise<Server>(resolve => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  servers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Test port unavailable");
  return `http://127.0.0.1:${address.port}/api/v2/agent-connections`;
}
const grantId = "b".repeat(32);

it("requires explicit browser consent, session and same-origin CSRF preflight before granting", async () => {
  const url = await endpoint({ authorizeAgentConnection: () => { throw new Error("Must not authorize"); } },
    { issue: async () => { throw new Error("Must not grant"); }, revoke: async () => false });
  expect((await fetch(url, { method: "POST", headers, body: "{}" })).status).toBe(400);
  for (const [candidate, status] of [[{ ...headers, origin: "https://attacker.invalid" }, 403],
    [{ ...headers, cookie: "" }, 401], [{ ...headers, "x-csrf-token": "" }, 403]] as const) {
    expect((await fetch(url, { method: "POST", headers: candidate, body: JSON.stringify({ consent: AGENT_CONSENT }) })).status).toBe(status);
  }
});

it("derives grant ownership from the verified account and returns no session credential", async () => {
  const url = await endpoint({ authorizeAgentConnection: () => ({ ok: true, owner }) },
    { issue: async received => { expect(received).toEqual(owner); return { grantId, expiresAt: 4000000000 }; },
      revoke: async () => true });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({
    consent: AGENT_CONSENT, userId: "other-adult", householdId: "other-family", scope: "write" }) });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.scopes).toEqual(["approved_history:read", "approved_source:read"]);
  expect(JSON.stringify(body)).not.toContain(owner.sessionTokenSha256);
  expect(body.storagePrivacy).toBe("trusted_server_readable");
});

it("revokes a just-issued connection if session authority changes while its file is written", async () => {
  let live = true; let revoked = false;
  const url = await endpoint({ authorizeAgentConnection: () => live ? { ok: true, owner }
    : { ok: false, status: 401, error: "AUTH_REQUIRED" } },
    { issue: async () => { live = false; return { grantId, expiresAt: 4000000000 }; },
      revoke: async () => { revoked = true; return true; } });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ consent: AGENT_CONSENT }) });
  expect(response.status).toBe(401); expect(revoked).toBe(true);
});

it("allows account-bound disconnect and uses generic denial for other accounts' grants", async () => {
  const url = await endpoint({ authorizeAgentConnection: () => ({ ok: true, owner }) },
    { issue: async () => ({ grantId, expiresAt: 4000000000 }), revoke: async (id, received) => {
      expect(received).toEqual(owner); return id === grantId;
    } });
  expect((await fetch(`${url}/${grantId}/disconnect`, { method: "POST", headers })).status).toBe(204);
  const denied = await fetch(`${url}/${"c".repeat(32)}/disconnect`, { method: "POST", headers });
  expect(denied.status).toBe(404); expect(await denied.json()).toEqual({ error: "NOT_FOUND" });
});

it("does not issue a connection when the verified account lacks adult approval authority", async () => {
  const url = await endpoint({ authorizeAgentConnection: () => ({ ok: false, status: 403, error: "FORBIDDEN" }) },
    { issue: async () => { throw new Error("Must not issue"); }, revoke: async () => false });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ consent: AGENT_CONSENT }) });
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "FORBIDDEN" });
});

it("redacts a failed final authority lookup and revokes the file already issued", async () => {
  let calls = 0; let revoked = false;
  const url = await endpoint({ authorizeAgentConnection: () => {
    if (++calls > 1) throw new Error("private database diagnostic");
    return { ok: true, owner };
  } }, { issue: async () => ({ grantId, expiresAt: 4000000000 }), revoke: async () => { revoked = true; return true; } });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ consent: AGENT_CONSENT }) });
  expect(response.status).toBe(503); expect(revoked).toBe(true);
  expect(await response.json()).toEqual({ error: "CONNECTION_UNAVAILABLE" });
});
