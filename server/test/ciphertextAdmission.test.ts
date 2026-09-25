import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";

import { encodeManagedVaultBlobV2, MANAGED_VAULT_CHUNK_BYTES,
  MAX_MANAGED_VAULT_BYTES, MAX_MANAGED_VAULT_WIRE_BYTES,
  MANAGED_VAULT_FORMAT_V2, type ManagedVaultChunkV2 } from "@adeno/contracts";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { issueCsrfToken, issueSessionToken, SESSION_COOKIE_NAME,
  verifyStoredMutationSession, type SessionRepository, type StoredSession } from
  "../src/auth/cookieSession.js";
import { createManagedCiphertextAdmissionRouter,
  ManagedVaultUploadExistsError, ManagedVaultUploadSessionError,
  type ManagedVaultUploadStore } from "../src/managed/ciphertextAdmission.js";
import type { VaultWireHeader, VaultWireChunk } from
  "../src/managed/vaultWireStream.js";

const origin = "https://fictional-adeno.example";
const intentId = "aa".repeat(16);
const blobId = "bb".repeat(16);
const otherIntentId = "cc".repeat(16);
const otherBlobId = "dd".repeat(16);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

function fictionalWire(version = 2, selectedBlobId = blobId) {
  const wire = Buffer.from(encodeManagedVaultBlobV2({ format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(selectedBlobId, "hex"), plaintextSize: 3,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [{ iv: new Uint8Array(12).fill(0x11),
      ciphertext: new Uint8Array(19).fill(0x22).buffer }] }));
  wire[4] = version;
  return wire;
}

async function fixture(options: { revokeBeforeCommit?: boolean;
  failOnCommit?: boolean; ingressDeadlineMs?: number } = {}) {
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
  const stored = new Map<string, Uint8Array>();
  let opened = 0;
  let committed = 0;
  let aborted = 0;
  let committedWireSha256: string | null = null;
  const store: ManagedVaultUploadStore = {
    open: async ({ session, preflight, intentId: requestedIntent, signal }) => {
      if (session.scope.householdId !== "fictional-family-a" ||
        requestedIntent !== intentId || signal.aborted) return null;
      opened += 1;
      let header: VaultWireHeader | null = null;
      const chunks: VaultWireChunk[] = [];
      return { expectedBlobId: blobId, sink: {
        begin: (value) => { header = value; },
        append: (value) => {
          chunks.push({ index: value.index, iv: Buffer.from(value.iv),
            ciphertext: Buffer.from(value.ciphertext) });
          if (options.revokeBeforeCommit) rows.get(preflight.tokenSha256)!.revokedAt = now;
        },
        commit: (value, wireSha256, commitSignal) => {
          if (commitSignal.aborted) throw new ManagedVaultUploadSessionError();
          if (options.failOnCommit)
            throw new Error("FICTIONAL_INTERNAL_MARKER_NOT_A_REAL_RECORD");
          const current = verifyStoredMutationSession(
            rows.get(preflight.tokenSha256) ?? null, preflight.csrfToken);
          if (!current.ok) throw new ManagedVaultUploadSessionError();
          if (header?.wireVersion !== 2 || value.blobId !== blobId ||
            requestedIntent !== intentId) throw new Error("synthetic intent mismatch");
          const key = `${current.session.scope.householdId}:${blobId}`;
          if (stored.has(key)) throw new ManagedVaultUploadExistsError();
          const payload: ManagedVaultChunkV2[] = chunks.map((chunk) => ({
            iv: chunk.iv,
            ciphertext: Uint8Array.from(chunk.ciphertext).buffer,
          }));
          stored.set(key, encodeManagedVaultBlobV2({ format: MANAGED_VAULT_FORMAT_V2,
            blobId: Buffer.from(blobId, "hex"),
            plaintextSize: value.plaintextSize, chunkSize: MANAGED_VAULT_CHUNK_BYTES,
            chunks: payload }));
          committedWireSha256 = wireSha256;
          committed += 1;
        },
        abort: () => { aborted += 1; chunks.length = 0; },
      } };
    },
  };
  const app = express();
  app.use(createManagedCiphertextAdmissionRouter({ sessions,
    expectedOrigin: origin, store,
    ...(options.ingressDeadlineMs === undefined ? {} :
      { ingressDeadlineMs: options.ingressDeadlineMs }) }));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fictional port missing");
  const base = `http://127.0.0.1:${address.port}/api/v3/vault/intents/`;
  const identity = (token: typeof first) => ({
    cookie: `${SESSION_COOKIE_NAME}=${token.plaintext}`,
    csrf: issueCsrfToken(rows.get(token.sha256)!.sessionId,
      rows.get(token.sha256)!.csrfSecret),
  });
  return { base, rows, stored, first: identity(first), second: identity(second),
    firstDigest: first.sha256, get opened() { return opened; },
    get committed() { return committed; }, get aborted() { return aborted; },
    get committedWireSha256() { return committedWireSha256; } };
}

function headers(identity: { cookie: string; csrf: string },
  extra: Record<string, string> = {}) {
  return { cookie: identity.cookie, origin, "x-csrf-token": identity.csrf,
    "sec-fetch-site": "same-origin", "content-type":
      "application/vnd.adeno.vault.v2", ...extra };
}

describe("unmounted managed ciphertext admission seam", () => {
  it("accepts only exact v2 bytes for an authorized fictional upload intent", async () => {
    const test = await fixture();
    const wire = fictionalWire(); // Structurally valid; deliberately not real AES-GCM.
    const url = `${test.base}${intentId}/blobs/${blobId}`;
    const response = await fetch(url, { method: "POST", headers: headers(test.first),
      body: wire });
    expect(response.status).toBe(201);
    expect(test.opened).toBe(1);
    expect(test.committed).toBe(1);
    expect(test.committedWireSha256).toBe(
      createHash("sha256").update(wire).digest("hex"));
    expect(Buffer.from(test.stored.get(`fictional-family-a:${blobId}`)!)).toEqual(wire);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.text())).not.toContain(blobId);
    const duplicate = await fetch(url, { method: "POST", headers: headers(test.first),
      body: wire });
    expect(duplicate.status).toBe(409);
    expect(test.committed).toBe(1);
  });

  it("hides another family and another intent before staging", async () => {
    const test = await fixture();
    const wire = fictionalWire();
    for (const [identity, id] of [[test.second, intentId],
      [test.first, otherIntentId]] as const) {
      const response = await fetch(`${test.base}${id}/blobs/${blobId}`,
        { method: "POST", headers: headers(identity), body: wire });
      expect(response.status).toBe(404);
    }
    expect(test.opened).toBe(0);
    expect(test.stored.size).toBe(0);
  });

  it("rejects a caller-chosen blob ID even when the intent and wire agree", async () => {
    const test = await fixture();
    const response = await fetch(`${test.base}${intentId}/blobs/${otherBlobId}`,
      { method: "POST", headers: headers(test.first),
        body: fictionalWire(2, otherBlobId) });
    expect(response.status).toBe(404);
    expect(test.opened).toBe(1);
    expect(test.aborted).toBe(1);
    expect(test.committed).toBe(0);
    expect(test.stored.size).toBe(0);
  });

  it("requires a fresh session, Origin and CSRF before reading ciphertext", async () => {
    const test = await fixture();
    const url = `${test.base}${intentId}/blobs/${blobId}`;
    const wire = fictionalWire();
    expect((await fetch(url, { method: "POST", body: wire,
      headers: { "content-type": "application/vnd.adeno.vault.v2" } })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: wire,
      headers: headers(test.first, { origin: "https://wrong.example" }) })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: wire,
      headers: headers(test.first, { "x-csrf-token": "bad" }) })).status).toBe(403);
    expect((await fetch(url, { method: "POST", body: wire,
      headers: headers(test.first, { "sec-fetch-site": "cross-site" }) })).status).toBe(403);
    test.rows.get(test.firstDigest)!.revokedAt = Math.floor(Date.now() / 1000);
    expect((await fetch(url, { method: "POST", body: wire,
      headers: headers(test.first) })).status).toBe(401);
    expect(test.opened).toBe(0);
  });

  it("rechecks revocation at commit and never publishes a staged upload", async () => {
    const test = await fixture({ revokeBeforeCommit: true });
    const response = await fetch(`${test.base}${intentId}/blobs/${blobId}`,
      { method: "POST", headers: headers(test.first), body: fictionalWire() });
    expect(response.status).toBe(401);
    expect(test.committed).toBe(0);
    expect(test.aborted).toBe(1);
    expect(test.stored.size).toBe(0);
  });

  it("rejects v1, unknown version, bad ID, truncation and trailing bytes", async () => {
    const test = await fixture();
    const url = `${test.base}${intentId}/blobs/${blobId}`;
    const wire = fictionalWire();
    const oversizedHeader = Buffer.from(wire);
    oversizedHeader.writeUInt32BE(MAX_MANAGED_VAULT_BYTES + 1, 21);
    const badBlobId = Buffer.from(wire);
    badBlobId[5] = badBlobId[5]! ^ 1;
    for (const changed of [fictionalWire(1), fictionalWire(3),
      wire.subarray(0, -1), Buffer.concat([wire, Buffer.from([0])]),
      badBlobId, oversizedHeader]) {
      const response = await fetch(url, { method: "POST",
        headers: headers(test.first), body: changed });
      expect(response.status).toBe(422);
    }
    expect(test.committed).toBe(0);
    expect(test.stored.size).toBe(0);
  });

  it("rejects the wrong media type before opening an upload intent", async () => {
    const test = await fixture();
    const response = await fetch(`${test.base}${intentId}/blobs/${blobId}`,
      { method: "POST", headers: headers(test.first,
        { "content-type": "application/pdf" }), body: fictionalWire() });
    expect(response.status).toBe(415);
    expect(test.opened).toBe(0);
  });

  it("rejects an oversized declared body before opening an upload intent", async () => {
    const test = await fixture();
    const url = `${test.base}${intentId}/blobs/${blobId}`;
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: {
        ...headers(test.first), "content-length": String(MAX_MANAGED_VAULT_WIRE_BYTES + 1),
      } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(413);
    expect(test.opened).toBe(0);
  });

  it("aborts a truncated staged upload exactly once", async () => {
    const test = await fixture();
    const response = await fetch(`${test.base}${intentId}/blobs/${blobId}`,
      { method: "POST", headers: headers(test.first),
        body: fictionalWire().subarray(0, -1) });
    expect(response.status).toBe(422);
    expect(test.aborted).toBe(1);
    expect(test.stored.size).toBe(0);
  });

  it("aborts stalled ciphertext ingress without publishing", async () => {
    const test = await fixture({ ingressDeadlineMs: 75 });
    const url = `${test.base}${intentId}/blobs/${blobId}`;
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(url, { method: "POST", headers: {
        ...headers(test.first), "transfer-encoding": "chunked",
      } });
      request.once("error", () => resolve());
      request.once("close", () => resolve());
      request.write(fictionalWire().subarray(0, 35), (error) => {
        if (error) reject(error);
      });
    });
    expect(test.opened).toBe(1);
    expect(test.committed).toBe(0);
    expect(test.stored.size).toBe(0);
    expect(test.aborted).toBe(1);
  });

  it("does not disclose internal storage failures in responses", async () => {
    const test = await fixture({ failOnCommit: true });
    const response = await fetch(`${test.base}${intentId}/blobs/${blobId}`,
      { method: "POST", headers: headers(test.first), body: fictionalWire() });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("UNAVAILABLE");
    expect(body).not.toContain("FICTIONAL_INTERNAL_MARKER");
    expect(test.stored.size).toBe(0);
    expect(test.aborted).toBe(1);
  });
});
