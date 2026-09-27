import { randomBytes } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";

import { Client, StreamableHTTPClientTransport } from
  "@modelcontextprotocol/client";
import express from "express";
import { afterEach, expect, it } from "vitest";

import { createFictionalConnectionProfileMcpRouter,
  type FictionalApprovedMcpConnection } from
  "../src/mcp/fictionalConnectionProfileHttp.js";

const FIXED_NOW = 1_800_000_000;
const live: Array<{ server: Server; close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const item of live.splice(0)) {
    await item.close();
    await new Promise<void>((resolve) => item.server.close(() => resolve()));
  }
});

async function fixture(options?: { externalSocket?: boolean }) {
  const token = randomBytes(32).toString("base64url");
  const grants = new Map<string, FictionalApprovedMcpConnection>();
  const app = express();
  let candidate: ReturnType<typeof createFictionalConnectionProfileMcpRouter>;
  app.use("/mcp", (request, response, next) => {
    if (options?.externalSocket)
      Object.defineProperty(request.socket, "remoteAddress", {
        value: "203.0.113.8", configurable: true });
    candidate.router(request, response, next);
  });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fictional MCP test port");
  const origin = `http://127.0.0.1:${address.port}`;
  let verificationCalls = 0;
  let rateLimit: "allow" | "deny" | "fail" = "allow";
  candidate = createFictionalConnectionProfileMcpRouter({
    expectedOrigin: origin, now: () => FIXED_NOW,
    verify: (received) => {
      verificationCalls += 1;
      return grants.get(received) ?? null;
    },
    rateLimit: () => {
      if (rateLimit === "fail") throw new Error("fictional limiter unavailable");
      return rateLimit === "allow";
    },
  });
  live.push({ server, close: candidate.close });
  const grant: FictionalApprovedMcpConnection = {
    subjectId: "1".repeat(32), approvedBySubjectId: "1".repeat(32),
    subjectHandle: "fictional_a", clientId: "fictional-client",
    resource: `${origin}/mcp`, scopes: ["mcp:profile"],
    memberKind: "adult", role: "adult", membershipActive: true,
    grantActive: true, approvedAt: FIXED_NOW - 30,
    expiresAt: FIXED_NOW + 300,
  };
  const approve = () => grants.set(token, { ...grant });
  const post = (bearer?: string, overrides: Record<string, string> = {}) =>
    fetch(`${origin}/mcp`, { method: "POST", headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...overrides,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "initialize", params: {
        protocolVersion: "2025-11-25",
        capabilities: {}, clientInfo: { name: "fictional-test",
          version: "0.1.0" },
      } }) });
  return { token, grants, grant, approve, origin, post,
    setRateLimit: (value: "allow" | "deny" | "fail") => {
      rateLimit = value;
    },
    verificationCalls: () => verificationCalls };
}

it("serves only an explicitly approved fictional connection-profile tool over HTTP MCP", async () => {
  const state = await fixture();
  state.approve();
  const client = new Client({ name: "fictional-mcp-client", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${state.origin}/mcp`), {
    authProvider: { token: async () => state.token },
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name))
      .toEqual(["get_connection_profile"]);
    const profile = await client.callTool({ name: "get_connection_profile",
      arguments: {} });
    expect(profile.isError).not.toBe(true);
    const content = profile.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("Expected text result");
    expect(JSON.parse(content.text)).toEqual({ connected: true,
      scope: "mcp:profile", subject: "fictional_a",
      private_records_available: false });
    expect(content.text).not.toContain(state.grant.subjectId);
    expect(content.text).not.toContain("@example.invalid");
    await expect(client.callTool({ name: "get_history_through_day",
      arguments: { careProfileId: "fictional" } })).rejects.toThrow();
    state.grants.set(state.token, { ...state.grant, grantActive: false });
    await expect(client.listTools()).rejects.toThrow();
  } finally {
    await client.close();
  }
});

it("denies unauthenticated, cross-origin, wrong-host and invalid adult grants before MCP dispatch", async () => {
  const state = await fixture();
  expect((await state.post()).status).toBe(401);
  expect((await state.post(state.token)).status).toBe(401);
  expect(state.verificationCalls()).toBe(1);
  state.approve();
  expect((await state.post(state.token,
    { origin: "https://attacker.invalid" })).status).toBe(403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${state.origin}/mcp`, {
      method: "POST", headers: { host: "attacker.invalid",
        authorization: `Bearer ${state.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream" },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "initialize", params: { protocolVersion: "2025-11-25",
        capabilities: {}, clientInfo: { name: "fictional-test",
          version: "0.1.0" } } }));
  });
  expect(wrongHost).toBe(403);
  const duplicateAuth = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${state.origin}/mcp`, {
      method: "POST", headers: {
        authorization: [`Bearer ${state.token}`, `Bearer ${state.token}`],
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end(JSON.stringify({ jsonrpc: "2.0", id: 2,
      method: "tools/list", params: {} }));
  });
  expect(duplicateAuth).toBe(401);
  expect((await state.post(state.token,
    { cookie: "fake=session" })).status).toBe(401);
  expect(state.verificationCalls()).toBe(1);
  expect((await fetch(`${state.origin}/mcp`, { method: "POST", headers: {
    authorization: `Bearer ${state.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }, body: "{not-json" })).status).toBe(400);
  expect((await fetch(`${state.origin}/mcp`, { method: "POST", headers: {
    authorization: `Bearer ${state.token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ padding: "x".repeat(20_000) }) })).status)
    .toBe(413);
  for (const change of [
    { resource: "https://other.invalid/mcp" },
    { scopes: ["mcp:records"] },
    { expiresAt: FIXED_NOW - 1 },
    { membershipActive: false },
    { memberKind: "child" as const, role: "child" as const },
    { approvedBySubjectId: "2".repeat(32) },
  ]) {
    state.grants.set(state.token, { ...state.grant, ...change });
    expect((await state.post(state.token)).status).toBe(401);
  }
  state.approve();
  state.setRateLimit("deny");
  expect((await state.post(state.token)).status).toBe(429);
  state.setRateLimit("fail");
  expect((await state.post(state.token)).status).toBe(503);
});

it("cannot construct this fictional HTTP endpoint outside a test process", () => {
  const prior = process.env.VITEST;
  process.env.VITEST = "";
  try {
    expect(() => createFictionalConnectionProfileMcpRouter({
      expectedOrigin: "http://127.0.0.1:4173",
      verify: () => null, rateLimit: () => true,
    })).toThrow("Fictional MCP transport requires localhost test mode");
  } finally {
    if (prior === undefined) delete process.env.VITEST;
    else process.env.VITEST = prior;
  }
});

it("denies a non-loopback peer even with a forged localhost Host and valid bearer", async () => {
  const state = await fixture({ externalSocket: true });
  state.approve();
  expect((await state.post(state.token)).status).toBe(403);
  expect(state.verificationCalls()).toBe(0);
});
