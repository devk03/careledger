import type { Server } from "node:http";

import express from "express";
import { afterEach, expect, it } from "vitest";

import { createManagedEmailVerificationRouter } from
  "../src/managed/managedEmailVerificationRouter.js";

const origin = "https://fictional.example";
const token = "a1".repeat(32);
const password = "fictional-recipient-passphrase";
const householdId = "b2".repeat(16);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve()))));
});

async function endpoint(options: { preParsed?: boolean;
  limiter?: "allow" | "deny" | "fail" | "token-deny" | "token-fail";
  service?: "allow" | "deny" | "fail" | "fail-once" | "bad-result" } = {}) {
  const calls: { token: string; password: string }[] = [];
  const rateCalls: unknown[] = [];
  let serviceCalls = 0;
  const app = express();
  if (options.preParsed) app.use(express.json({ limit: "1mb" }));
  app.use("/api/managed/auth", createManagedEmailVerificationRouter({
    expectedOrigin: origin, bucketKey: Buffer.alloc(32, 7),
    rateLimit(input) {
      rateCalls.push(input);
      if (options.limiter === "fail" || (options.limiter === "token-fail" &&
        input.action === "verify-token")) throw new Error("private limiter");
      return options.limiter !== "deny" &&
        !(options.limiter === "token-deny" && input.action === "verify-token");
    },
    verification: { async consumeOrReadReceipt(value) {
      calls.push(value);
      serviceCalls += 1;
      if (options.service === "fail") throw new Error("private verification");
      if (options.service === "fail-once" && serviceCalls === 1)
        throw new Error("fictional uncertain verification result");
      if (options.service === "bad-result")
        return { householdId: "not-an-id" };
      return options.service === "deny" || value.token !== token ? null :
        { householdId };
    } },
  }));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing fictional test port");
  const url = `http://127.0.0.1:${address.port}/api/managed/auth/verify-email`;
  const headers = { origin, "sec-fetch-site": "same-origin",
    "content-type": "application/json" };
  const post = (body: unknown, overrides: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { ...headers, ...overrides },
      body: JSON.stringify(body) });
  return { url, headers, post, calls, rateCalls };
}

it("returns the family ID only after service acceptance, without a cookie", async () => {
  const fixture = await endpoint();
  const accepted = await fixture.post({ token, password });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ verified: true, householdId });
  expect(accepted.headers.get("set-cookie")).toBeNull();
  expect(accepted.headers.get("cache-control")).toBe("no-store");
  expect(accepted.headers.get("referrer-policy")).toBe("no-referrer");
  expect(accepted.headers.get("access-control-allow-origin")).toBeNull();
  expect(fixture.calls).toEqual([{ token, password }]);
  expect(JSON.stringify(fixture.rateCalls)).not.toContain(token);
  expect(JSON.stringify(fixture.rateCalls)).not.toContain(password);
  expect(fixture.rateCalls).toEqual(expect.arrayContaining([
    expect.objectContaining({ action: "verify-ip" }),
    expect.objectContaining({ action: "verify-token",
      tokenBucket: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
  ]));
  for (const service of ["deny", "allow"] as const) {
    const invalid = await endpoint({ service });
    const response = await invalid.post({ token: "c3".repeat(32), password });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const uncertain = await endpoint({ service: "fail-once" });
  // Transport-only recovery after an injected error. This mock has no durable
  // commit, so the real service still needs a lost-response/replay test.
  expect((await uncertain.post({ token, password })).status).toBe(503);
  const recovered = await uncertain.post({ token, password });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({ verified: true, householdId });
  expect(recovered.headers.get("set-cookie")).toBeNull();
});

it("rejects unsafe requests before verification and hides service failures", async () => {
  const fixture = await endpoint();
  for (const overrides of [
    { origin: "https://attacker.example" },
    { "sec-fetch-site": "cross-site" },
  ]) expect((await fixture.post({ token, password }, overrides)).status).toBe(403);
  for (const body of [null, [], {}, { token }, { token: "x", password },
    { token: token.toUpperCase(), password }, { token, password: "short" },
    { token, password: "x".repeat(129) },
    { token, password: "a\0b".padEnd(12, "x") },
    { token, password: "💠".repeat(128) + "x" },
    { token, password, extra: "x" }])
    expect((await fixture.post(body)).status).toBe(400);
  expect((await fetch(fixture.url, { method: "POST",
    headers: fixture.headers, body: "{bad" })).status).toBe(400);
  expect((await fixture.post({ token, password,
    padding: "x".repeat(1200) })).status)
    .toBe(413);
  expect((await fixture.post({ token, password },
    { "content-encoding": "gzip" })).status).toBe(400);
  expect((await fetch(fixture.url, { method: "GET",
    headers: fixture.headers })).status).toBe(405);
  expect(fixture.calls).toHaveLength(0);
  const preParsed = await endpoint({ preParsed: true });
  expect((await preParsed.post({ token, password })).status).toBe(400);
  expect(preParsed.calls).toHaveLength(0);
  for (const [limiter, status] of [["deny", 429], ["fail", 503],
    ["token-deny", 429], ["token-fail", 503]] as const) {
    const limited = await endpoint({ limiter });
    expect((await limited.post({ token, password })).status).toBe(status);
    expect(limited.calls).toHaveLength(0);
  }
  for (const service of ["fail", "bad-result"] as const) {
    const rejected = await endpoint({ service });
    const response = await rejected.post({ token, password });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "REQUEST_DENIED" });
    expect(response.headers.get("set-cookie")).toBeNull();
  }
});
