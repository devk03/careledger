import { createHash } from "node:crypto";
import type { Server } from "node:http";

import express from "express";
import { encodeDeviceEnrollmentChallengeWireV1,
  encodeSessionDeviceChallengeWireV1 } from "@adeno/contracts";
import { afterEach, expect, it } from "vitest";

import { issueSessionToken, SESSION_COOKIE_NAME } from
  "../src/auth/cookieSession.js";
import { createManagedDeviceRouter,
  type ManagedDeviceRouterDependencies } from
  "../src/managed/managedDeviceRouter.js";

const origin = "https://fictional.example";
const id = (byte: string) => byte.repeat(32);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve()))));
});

async function endpoint(options?: { limit?: "allow" | "deny" | "fail";
  service?: "allow" | "deny"; preParsed?: boolean }) {
  const token = issueSessionToken();
  const calls: Array<{ action: string; input: unknown }> = [];
  const rateCalls: Array<unknown> = [];
  const dependencies: ManagedDeviceRouterDependencies = {
    expectedOrigin: origin,
    rateLimit: (input) => {
      rateCalls.push(input);
      if (options?.limit === "fail") throw new Error("private limiter failure");
      return options?.limit !== "deny";
    },
    enrollment: {
      issueWire(input) {
        calls.push({ action: "enrollment-challenge", input });
        if (options?.service === "deny") throw new Error("private family state");
        return encodeDeviceEnrollmentChallengeWireV1({ householdId: id("1"),
          accountId: id("2"), sessionId: id("3"), challengeId: id("4"),
          ephemeralPublicKey: Buffer.alloc(32, 9),
          encryptionPublicKey: Buffer.alloc(32, 7),
          signingPublicKey: Buffer.alloc(32, 8),
          expiresAt: 1_800_000_000n });
      },
      proveWire(input) {
        calls.push({ action: "enrollment-proof", input });
        if (options?.service === "deny") throw new Error("private family state");
        return { deviceId: id("4"), state: "pending" };
      },
    },
    binding: {
      issueWire(input) {
        calls.push({ action: "binding-challenge", input });
        if (options?.service === "deny") throw new Error("private family state");
        return encodeSessionDeviceChallengeWireV1({ householdId: id("1"),
          accountId: id("2"), sessionId: id("3"), deviceId: id("4"),
          challengeId: id("5"), nonce: Buffer.alloc(32, 6),
          expiresAt: 1_800_000_000n });
      },
      bindWire(input) {
        calls.push({ action: "binding-proof", input });
        if (options?.service === "deny") throw new Error("private family state");
      },
    },
  };
  const app = express();
  if (options?.preParsed) app.use(express.json({ limit: "1mb" }));
  app.use("/api/managed/device", createManagedDeviceRouter(dependencies));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fictional test port");
  const base = `http://127.0.0.1:${address.port}/api/managed/device`;
  const headers = { origin, "sec-fetch-site": "same-origin",
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    "x-csrf-token": "fictional-csrf", "content-type": "application/json" };
  async function post(path: string, body: unknown,
    overrides: Record<string, string> = {}) {
    return fetch(`${base}/${path}`, { method: "POST",
      headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  }
  return { base, headers, post, calls, rateCalls, token };
}

it("keeps all four opaque device operations behind cookie, origin, CSRF and no-store", async () => {
  const fixture = await endpoint();
  const enrollment = await fixture.post("enrollment-challenge", {
    encryptionPublicKeyHex: "07".repeat(32),
    signingPublicKeyHex: "08".repeat(32),
  });
  expect(enrollment.status).toBe(201);
  expect(enrollment.headers.get("cache-control")).toBe("no-store");
  expect(enrollment.headers.get("x-content-type-options")).toBe("nosniff");
  expect(enrollment.headers.get("access-control-allow-origin")).toBeNull();
  expect(enrollment.headers.get("x-powered-by")).toBeNull();
  expect((await enrollment.json()).format)
    .toBe("adeno:device-enrollment-challenge:v1");
  const pending = await fixture.post("enrollment-proof", { proof: {
    format: "adeno:device-enrollment-proof:v1", challengeId: id("4"),
    nonceHex: "06".repeat(32), signatureHex: "09".repeat(64),
  } });
  expect(pending.status).toBe(201);
  expect(await pending.json()).toEqual({ deviceId: id("4"), state: "pending" });
  const binding = await fixture.post("binding-challenge", { deviceId: id("4") });
  expect(binding.status).toBe(201);
  expect((await binding.json()).format)
    .toBe("adeno:session-device-challenge:v1");
  const confirmed = await fixture.post("binding-proof", { proof: {
    format: "adeno:session-device-proof:v1", challengeId: id("5"),
    nonceHex: "06".repeat(32), signatureHex: "09".repeat(64),
  } });
  expect(confirmed.status).toBe(204);
  expect(await confirmed.text()).toBe("");
  expect(fixture.calls.map((call) => call.action)).toEqual([
    "enrollment-challenge", "enrollment-proof", "binding-challenge",
    "binding-proof",
  ]);
  expect(fixture.calls[0]?.input).toEqual({
    tokenSha256: createHash("sha256").update(fixture.token.plaintext)
      .digest("hex"), csrfToken: "fictional-csrf",
    encryptionPublicKeyHex: "07".repeat(32),
    signingPublicKeyHex: "08".repeat(32),
  });
  expect(fixture.rateCalls).toHaveLength(4);
  expect(fixture.rateCalls[0]).toEqual({
    tokenSha256: fixture.token.sha256,
    remoteAddress: expect.stringMatching(/127\.0\.0\.1/u),
    action: "enrollment-challenge",
  });
  const unsupported = await fetch(`${fixture.base}/binding-challenge`, {
    method: "OPTIONS", headers: fixture.headers });
  expect(unsupported.status).toBe(405);
  expect(unsupported.headers.get("access-control-allow-origin")).toBeNull();
});

it("denies cross-origin, cross-site, missing or duplicate cookie, and missing CSRF before services", async () => {
  const fixture = await endpoint();
  const body = { deviceId: id("4") };
  for (const overrides of [
    { origin: "https://attacker.example" },
    { "sec-fetch-site": "cross-site" },
    { cookie: "" },
    { cookie: `${fixture.headers.cookie}; ${fixture.headers.cookie}` },
    { "x-csrf-token": "" },
  ]) {
    const response = await fixture.post("binding-challenge", body, overrides);
    expect([401, 403]).toContain(response.status);
    expect(await response.json()).toEqual({ error: "REQUEST_DENIED" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const noOrigin = await fetch(`${fixture.base}/binding-challenge`, {
    method: "POST", headers: {
      "content-type": "application/json", cookie: fixture.headers.cookie,
      "x-csrf-token": fixture.headers["x-csrf-token"],
      "sec-fetch-site": "same-origin",
    }, body: JSON.stringify(body) });
  expect(noOrigin.status).toBe(403);
  expect(fixture.calls).toHaveLength(0);
  expect(fixture.rateCalls).toHaveLength(0);
});

it("rejects malformed, unknown, oversized and encoded bodies without invoking services", async () => {
  const fixture = await endpoint();
  for (const body of [null, [], { deviceId: id("4"), householdId: id("1") },
    { proof: {}, extra: true }]) {
    const path = body && "deviceId" in body ? "binding-challenge" :
      "binding-proof";
    const response = await fixture.post(path, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
  }
  const malformed = await fetch(`${fixture.base}/binding-proof`, {
    method: "POST", headers: fixture.headers, body: "{unclosed" });
  expect(malformed.status).toBe(400);
  const oversized = await fetch(`${fixture.base}/binding-proof`, {
    method: "POST", headers: fixture.headers,
    body: JSON.stringify({ proof: "x".repeat(3000) }) });
  expect(oversized.status).toBe(413);
  const encoded = await fixture.post("binding-proof", { proof: {} },
    { "content-encoding": "gzip" });
  expect(encoded.status).toBe(415);
  const wrongType = await fixture.post("binding-proof", { proof: {} },
    { "content-type": "text/plain" });
  expect(wrongType.status).toBe(400);
  for (const action of ["enrollment-proof", "binding-proof"]) {
    const nested = await fixture.post(action, { proof: {} });
    expect(nested.status).toBe(400);
    expect(await nested.json()).toEqual({ error: "INVALID_REQUEST" });
  }
  expect(fixture.calls).toHaveLength(0);
});

it("fails closed on limiter and service denial without exposing details", async () => {
  for (const [limit, expected] of [["deny", 429], ["fail", 503]] as const) {
    const fixture = await endpoint({ limit });
    const response = await fixture.post("binding-challenge", { deviceId: id("4") });
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({ error: "REQUEST_DENIED" });
    expect(fixture.calls).toHaveLength(0);
  }
  const denied = await endpoint({ service: "deny" });
  const response = await denied.post("binding-challenge", { deviceId: id("4") });
  expect(response.status).toBe(403);
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ error: "REQUEST_DENIED" });
  expect(body).not.toContain("private family state");
});

it("refuses an upstream body parser that could bypass its size limit", async () => {
  const fixture = await endpoint({ preParsed: true });
  const response = await fixture.post("binding-challenge", { deviceId: id("4") });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
  expect(fixture.calls).toHaveLength(0);
});
