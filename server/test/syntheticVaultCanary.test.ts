import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { issueCsrfToken, issueSessionToken, SESSION_COOKIE_NAME,
  type SessionRepository, type StoredSession } from "../src/auth/cookieSession.js";
import { createSyntheticVaultCanaryApp,
  type SyntheticVaultCanaryStore } from "../src/managed/syntheticVaultCanary.js";

const origin = "https://fictional-adeno.example";
const marker = "FICTIONAL_HEALTH_MARKER_NOT_A_REAL_RECORD";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve()))));
});

function fictionalWire(householdId: string, objectId = "opaque-object-a") {
  const plaintext = Buffer.from(marker, "utf8");
  const key = randomBytes(32);
  const blobId = randomBytes(16);
  const iv = randomBytes(12);
  const aad = Buffer.from(JSON.stringify({ format: "careledger.e2ee.v1",
    blobId: blobId.toString("base64url"), householdId, objectId, revision: 1,
    index: 0, totalChunks: 1, plaintextSize: plaintext.length }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const wire = Buffer.alloc(33 + 12 + 4 + ciphertext.length);
  wire.write("ADEN", 0, "ascii");
  wire[4] = 1;
  blobId.copy(wire, 5);
  wire.writeUInt32BE(plaintext.length, 21);
  wire.writeUInt32BE(1024 * 1024, 25);
  wire.writeUInt32BE(1, 29);
  iv.copy(wire, 33);
  wire.writeUInt32BE(ciphertext.length, 45);
  ciphertext.copy(wire, 49);
  return { blobId: blobId.toString("hex"), wire, key, iv, aad, plaintext };
}

function decrypted(wire: Buffer, fixture: ReturnType<typeof fictionalWire>) {
  const ciphertext = wire.subarray(49);
  const decipher = createDecipheriv("aes-256-gcm", fixture.key, fixture.iv);
  decipher.setAAD(fixture.aad);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}

async function canary() {
  const first = issueSessionToken();
  const second = issueSessionToken();
  const now = Math.floor(Date.now() / 1000);
  const row = (householdId: string, userId: string): StoredSession => ({
    sessionId: `${userId}-fictional-session`, householdId, userId,
    userStatus: "active", sessionAuthVersion: 1, userAuthVersion: 1,
    expiresAt: now + 3600, revokedAt: null, csrfSecret: randomBytes(32),
  });
  const rows = new Map([[first.sha256, row("fictional-family-a", "adult-a")],
    [second.sha256, row("fictional-family-b", "adult-b")]]);
  const sessions: SessionRepository = {
    findByTokenSha256: async (digest) => rows.get(digest) ?? null,
  };
  const stored = new Map<string, Buffer>();
  let failRead = false;
  const store: SyntheticVaultCanaryStore = {
    create: ({ scope, blobId, wire }) => {
      const key = `${scope.householdId}:${blobId}`;
      if (stored.has(key)) return "exists";
      stored.set(key, Buffer.from(wire));
      return "stored";
    },
    read: ({ scope, blobId }) => {
      if (failRead) throw new Error(`Internal failure: ${marker}`);
      const wire = stored.get(`${scope.householdId}:${blobId}`);
      return wire ? Buffer.from(wire) : null;
    },
  };
  const app = createSyntheticVaultCanaryApp({ sessions, expectedOrigin: origin, store });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic port unavailable");
  const base = `http://127.0.0.1:${address.port}/__canary/vault/blobs/`;
  const identity = (token: typeof first, householdId: string) => ({
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    csrf: issueCsrfToken(rows.get(token.sha256)!.sessionId,
      rows.get(token.sha256)!.csrfSecret),
    householdId,
  });
  return { base, stored, rows, failNextRead: () => { failRead = true; },
    first: identity(first, "fictional-family-a"),
    second: identity(second, "fictional-family-b"), firstDigest: first.sha256 };
}

function uploadHeaders(identity: { cookie: string; csrf: string },
  overrides: Record<string, string> = {}) {
  return { cookie: identity.cookie, origin, "sec-fetch-site": "same-origin",
    "x-csrf-token": identity.csrf,
    "content-type": "application/vnd.adeno.vault.v1", ...overrides };
}

describe("synthetic ciphertext HTTP canary only", () => {
  it("refuses to mount outside the test environment", () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => createSyntheticVaultCanaryApp({
        sessions: { findByTokenSha256: async () => null },
        expectedOrigin: origin,
        store: { create: () => "stored", read: () => null },
      })).toThrow("SYNTHETIC_CANARY_TEST_ONLY");
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("stores and returns exact encrypted bytes with no fictional plaintext", async () => {
    const fixture = fictionalWire("fictional-family-a");
    const test = await canary();
    const url = test.base + fixture.blobId;
    const put = await fetch(url, { method: "POST", headers: uploadHeaders(test.first),
      body: fixture.wire });
    expect(put.status).toBe(201);
    const saved = test.stored.get(`fictional-family-a:${fixture.blobId}`)!;
    expect(saved.equals(fixture.wire)).toBe(true);
    expect(saved.includes(Buffer.from(marker))).toBe(false);
    expect(saved.includes(fixture.key)).toBe(false);
    const response = await fetch(url, { headers: { cookie: test.first.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/vnd.adeno.vault.v1");
    const returned = Buffer.from(await response.arrayBuffer());
    expect(returned.equals(fixture.wire)).toBe(true);
    expect(decrypted(returned, fixture)).toEqual(fixture.plaintext);
    const altered = Buffer.from(returned);
    altered[49] = altered[49]! ^ 1;
    expect(() => decrypted(altered, fixture)).toThrow();
  });

  it("requires fresh cookie, origin, and CSRF; revocation takes effect next request", async () => {
    const fixture = fictionalWire("fictional-family-a");
    const test = await canary();
    const url = test.base + fixture.blobId;
    expect((await fetch(url, { method: "POST", headers: { origin,
      "content-type": "application/vnd.adeno.vault.v1" }, body: fixture.wire })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first,
      { origin: "https://wrong.example" }), body: fixture.wire })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first,
      { "x-csrf-token": "bad" }), body: fixture.wire })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first,
      { "sec-fetch-site": "cross-site" }), body: fixture.wire })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first),
      body: fixture.wire })).status).toBe(201);
    test.rows.get(test.firstDigest)!.revokedAt = Math.floor(Date.now() / 1000);
    expect((await fetch(url, { headers: { cookie: test.first.cookie } })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first),
      body: fixture.wire })).status).toBe(401);
  });

  it("hides another household and cannot overwrite a committed ciphertext", async () => {
    const fixture = fictionalWire("fictional-family-a");
    const test = await canary();
    const url = test.base + fixture.blobId;
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first),
      body: fixture.wire })).status).toBe(201);
    expect((await fetch(url, { headers: { cookie: test.second.cookie } })).status).toBe(404);
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first),
      body: fixture.wire })).status).toBe(409);
    expect(test.stored.get(`fictional-family-a:${fixture.blobId}`)!.equals(fixture.wire)).toBe(true);
  });

  it("does not expose internal storage failures as a client or parsing error", async () => {
    const fixture = fictionalWire("fictional-family-a");
    const test = await canary();
    const url = test.base + fixture.blobId;
    expect((await fetch(url, { method: "POST", headers: uploadHeaders(test.first),
      body: fixture.wire })).status).toBe(201);
    test.failNextRead();
    const response = await fetch(url, { headers: { cookie: test.first.cookie } });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("UNAVAILABLE");
    expect(body).not.toContain(marker);
    expect(body).not.toContain("Internal failure");
  });

  it("rejects wrong type, mismatched ID, truncated bytes, and over-limit bodies", async () => {
    const fixture = fictionalWire("fictional-family-a");
    const test = await canary();
    const url = test.base + fixture.blobId;
    const send = (target: string, body: Buffer, headers = uploadHeaders(test.first)) =>
      fetch(target, { method: "POST", headers, body });
    expect((await send(url, fixture.wire,
      uploadHeaders(test.first, { "content-type": "application/pdf" }))).status).toBe(415);
    expect((await send(test.base + "0".repeat(32), fixture.wire)).status).toBe(400);
    expect((await send(url, fixture.wire.subarray(0, -1))).status).toBe(400);
    const tooLarge = await send(url, Buffer.alloc(64 * 1024 + 1));
    expect(tooLarge.status).toBe(413);
    expect(JSON.stringify(await tooLarge.json())).not.toContain(marker);
    expect(test.stored.size).toBe(0);
    expect((await fetch(test.base.replace("/__canary/vault/blobs/", "/api/records"))).status)
      .toBe(404);
  });
});
