import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { issueCsrfToken, issueSessionToken, SESSION_COOKIE_NAME } from
  "../src/auth/cookieSession.js";
import { ManagedVaultUploadSessionError } from
  "../src/managed/ciphertextAdmission.js";
import { createManagedUploadReceiptRouter, ManagedUploadReceiptCsrfError,
  type ManagedUploadReceipt,
  type ManagedUploadReceiptReader } from
  "../src/managed/uploadReceipt.js";

const origin = "https://fictional-adeno.example";
const intentId = "aa".repeat(16);
const blobId = "bb".repeat(16);
const digest = "cc".repeat(32);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture() {
  const first = issueSessionToken();
  const other = issueSessionToken();
  const secret = randomBytes(32);
  const csrf = issueCsrfToken(intentId, secret);
  const calls: string[] = [];
  const reader: ManagedUploadReceiptReader = {
    readReceipt: async ({ tokenSha256, csrfToken, intentId: selectedIntent,
      blobId: selectedBlob }) => {
      calls.push(tokenSha256);
      if (tokenSha256 === other.sha256) return null;
      if (tokenSha256 !== first.sha256)
        throw new ManagedVaultUploadSessionError();
      if (csrfToken !== csrf) throw new ManagedUploadReceiptCsrfError();
      if (selectedIntent !== intentId || selectedBlob !== blobId) return null;
      return { status: "committed", wireSha256: digest, wireBytes: 84 };
    },
  };
  const app = express();
  app.use(createManagedUploadReceiptRouter({ expectedOrigin: origin, reader }));
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fictional port missing");
  const url = `http://127.0.0.1:${address.port}/api/v3/vault/intents/` +
    `${intentId}/blobs/${blobId}/receipt`;
  const headers = (token = first.plaintext, selectedCsrf = csrf) => ({
    cookie: `${SESSION_COOKIE_NAME}=${token}`, origin,
    "x-csrf-token": selectedCsrf, "sec-fetch-site": "same-origin",
  });
  return { url, reader, calls, headers, other };
}

describe("unmounted managed ciphertext receipt route", () => {
  it("returns only a committed ciphertext receipt for a current authorized session", async () => {
    const test = await fixture();
    const response = await fetch(test.url, { method: "POST", headers: test.headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "committed",
      wireSha256: digest, wireBytes: 84 });
    expect(test.calls).toHaveLength(1);
  });

  it("keeps an absent commit unconfirmed rather than implying a safe retry", async () => {
    const test = await fixture();
    test.reader.readReceipt = async () => ({ status: "unconfirmed" });
    const response = await fetch(test.url, { method: "POST", headers: test.headers() });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "unconfirmed" });
  });

  it("projects only receipt fields even if a reader returns extra metadata", async () => {
    const test = await fixture();
    test.reader.readReceipt = async () => ({ status: "committed",
      wireSha256: digest, wireBytes: 84,
      internalMarker: "not-for-the-browser" } as ManagedUploadReceipt);
    const response = await fetch(test.url, { method: "POST", headers: test.headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "committed",
      wireSha256: digest, wireBytes: 84 });
  });

  it("hides other-family and wrong-blob lookups identically", async () => {
    const test = await fixture();
    const otherFamily = await fetch(test.url, { method: "POST",
      headers: test.headers(test.other.plaintext) });
    const wrongBlob = await fetch(test.url.replace(blobId, "dd".repeat(16)),
      { method: "POST", headers: test.headers() });
    expect(otherFamily.status).toBe(404);
    expect(wrongBlob.status).toBe(404);
    expect(await otherFamily.json()).toEqual(await wrongBlob.json());
  });

  it("rejects cross-origin, bad CSRF, body and invalid session before any receipt", async () => {
    const test = await fixture();
    const wrongOrigin = await fetch(test.url, { method: "POST",
      headers: { ...test.headers(), origin: "https://wrong.example" } });
    const wrongCsrf = await fetch(test.url, { method: "POST",
      headers: test.headers(undefined, "bad") });
    const withBody = await fetch(test.url, { method: "POST",
      headers: test.headers(), body: "x" });
    const invalidSession = await fetch(test.url, { method: "POST",
      headers: test.headers(issueSessionToken().plaintext) });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongCsrf.status).toBe(403);
    expect(withBody.status).toBe(400);
    expect(invalidSession.status).toBe(401);
    expect(test.calls).toHaveLength(2); // CSRF and session are rechecked by the ledger.
  });
});
