import type { Server } from "node:http";

import express from "express";
import { afterEach, expect, it } from "vitest";

import { issueSessionToken, SESSION_COOKIE_NAME } from
  "../src/auth/cookieSession.js";
import { createManagedAuthRouter } from
  "../src/managed/managedAuthRouter.js";

const origin = "https://fictional.example";
const familyId = "11".repeat(16);
const accountId = "22".repeat(16);
const sessionId = "33".repeat(16);
const token = issueSessionToken();
const publicSession = { householdId: familyId, accountId, sessionId,
  csrfToken: "fictional-csrf", expiresAt: 1_800_000_000,
  role: "owner" as const, memberKind: "adult" as const };
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve()))));
});

async function endpoint(options?: { limit?: "allow" | "deny" | "fail" |
  "credential-deny" | "credential-fail";
  service?: "allow" | "deny"; preParsed?: boolean }) {
  const calls: Array<{ action: string; input: unknown }> = [];
  const rateCalls: unknown[] = [];
  let revoked = false;
  const app = express();
  if (options?.preParsed) app.use(express.json({ limit: "1mb" }));
  app.use("/api/managed/auth", createManagedAuthRouter({
    expectedOrigin: origin,
    credentialBucketKey: Buffer.alloc(32, 7),
    rateLimit: (input) => {
      rateCalls.push(input);
      if (options?.limit === "fail" ||
        (options?.limit === "credential-fail" &&
          input.action === "login-credential"))
        throw new Error("private limiter failure");
      return options?.limit !== "deny" &&
        !(options?.limit === "credential-deny" &&
          input.action === "login-credential");
    },
    identity: {
      async login(input) {
        calls.push({ action: "login", input });
        if (options?.service === "deny") throw new Error("private account state");
        return { ...publicSession, sessionToken: token.plaintext };
      },
      readSession(tokenSha256) {
        calls.push({ action: "session", input: tokenSha256 });
        return tokenSha256 === token.sha256 && !revoked ? publicSession : null;
      },
      logout(input) {
        calls.push({ action: "logout", input });
        if (options?.service === "deny") throw new Error("private account state");
        revoked = true;
      },
    },
  }));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fictional test port");
  const base = `http://127.0.0.1:${address.port}/api/managed/auth`;
  const headers = { origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json" };
  const loginBody = { email: "fictional@example.invalid",
    password: "fictional-password-phrase", householdId: familyId };
  async function post(path: string, body: unknown,
    overrides: Record<string, string> = {}) {
    return fetch(`${base}/${path}`, { method: "POST",
      headers: { ...headers, ...overrides },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  return { base, headers, post, calls, rateCalls, loginBody };
}

it("sets only a secure cookie on verified login and reads a fresh session", async () => {
  const fixture = await endpoint();
  const login = await fixture.post("login", fixture.loginBody);
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie");
  expect(cookie).toContain(`${SESSION_COOKIE_NAME}=${token.plaintext}`);
  expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict");
  expect(cookie).not.toContain("Domain=");
  expect(login.headers.get("cache-control")).toBe("no-store");
  expect(login.headers.get("access-control-allow-origin")).toBeNull();
  const publicBody = await login.text();
  expect(JSON.parse(publicBody)).toEqual(publicSession);
  expect(publicBody).not.toContain(token.plaintext);
  const session = await fetch(`${fixture.base}/session`, { headers: {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "sec-fetch-site": "same-origin",
  } });
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual(publicSession);
  const logout = await fixture.post("logout", undefined, {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "x-csrf-token": "fictional-csrf",
  });
  expect(logout.status).toBe(204);
  expect(logout.headers.get("set-cookie"))
    .toContain(`${SESSION_COOKIE_NAME}=; Max-Age=0`);
  expect((await fetch(`${fixture.base}/session`, { headers: {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "sec-fetch-site": "same-origin",
  } })).status).toBe(401);
  expect(fixture.calls.map((call) => call.action)).toEqual([
    "login", "session", "logout", "session",
  ]);
  expect(fixture.rateCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "login-ip" }),
    expect.objectContaining({ action: "login-credential",
      credentialBucket: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
  ]));
  expect(JSON.stringify(fixture.rateCalls)).not.toContain(fixture.loginBody.email);
});

it("rejects wrong origin, Fetch Metadata, malformed login JSON and body bypass", async () => {
  const fixture = await endpoint();
  for (const overrides of [
    { origin: "https://attacker.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const denied = await fixture.post("login", fixture.loginBody, overrides);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "REQUEST_DENIED" });
  }
  for (const body of [null, [], { ...fixture.loginBody, tokenSha256: "x" },
    { ...fixture.loginBody, householdId: "bad" }]) {
    const invalid = await fixture.post("login", body);
    expect(invalid.status).toBe(400);
  }
  const malformed = await fetch(`${fixture.base}/login`, { method: "POST",
    headers: fixture.headers, body: "{bad" });
  expect(malformed.status).toBe(400);
  expect((await fixture.post("login", { ...fixture.loginBody,
    password: "x".repeat(3000) })).status).toBe(413);
  expect((await fixture.post("login", fixture.loginBody,
    { "content-encoding": "gzip" })).status).toBe(400);
  expect(fixture.calls).toHaveLength(0);
  const preParsed = await endpoint({ preParsed: true });
  expect((await preParsed.post("login", preParsed.loginBody)).status).toBe(400);
  expect(preParsed.calls).toHaveLength(0);
});

it("denies invalid cookies, cross-site session reads, CSRF-less logout and unknown methods", async () => {
  const fixture = await endpoint();
  const sessionUrl = `${fixture.base}/session`;
  for (const headers of [
    {},
    { cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}` },
    { cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}; ` +
      `${SESSION_COOKIE_NAME}=${token.plaintext}` },
    { cookie: `${SESSION_COOKIE_NAME}=bad` },
    { cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
      "sec-fetch-site": "cross-site" },
  ]) {
    const response = await fetch(sessionUrl, { headers });
    expect([401, 403]).toContain(response.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const csrfLess = await fixture.post("logout", undefined, {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}` });
  expect(csrfLess.status).toBe(403);
  expect((await fixture.post("logout", { extra: true }, {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "x-csrf-token": "fictional-csrf" })).status).toBe(400);
  const options = await fetch(`${fixture.base}/login`, {
    method: "OPTIONS", headers: fixture.headers });
  expect(options.status).toBe(405);
  expect(options.headers.get("access-control-allow-origin")).toBeNull();
  expect((await fixture.post("register", fixture.loginBody)).status).toBe(404);
  expect(fixture.calls).toHaveLength(0);
});

it("fails closed before Argon2 when either limiter denies and hides account errors", async () => {
  for (const [limit, status] of [["deny", 429], ["fail", 503],
    ["credential-deny", 429], ["credential-fail", 503]] as const) {
    const fixture = await endpoint({ limit });
    const response = await fixture.post("login", fixture.loginBody);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "REQUEST_DENIED" });
    expect(fixture.calls).toHaveLength(0);
  }
  const denied = await endpoint({ service: "deny" });
  const response = await denied.post("login", denied.loginBody);
  expect(response.status).toBe(403);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error: "REQUEST_DENIED" });
  expect(body).not.toContain("private account state");
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("recovers the CSRF token and revokes the cookie when the limiter is unavailable", async () => {
  const fixture = await endpoint({ limit: "fail" });
  const session = await fetch(`${fixture.base}/session`, { headers: {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "sec-fetch-site": "same-origin",
  } });
  expect(session.status).toBe(200);
  expect((await session.json()).csrfToken).toBe("fictional-csrf");
  const response = await fixture.post("logout", undefined, {
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "x-csrf-token": "fictional-csrf",
  });
  expect(response.status).toBe(204);
  expect(fixture.calls.map((call) => call.action)).toEqual([
    "session", "logout",
  ]);
  expect(fixture.rateCalls).toHaveLength(0);
});
