import { createHash, createHmac } from "node:crypto";
import type { Request } from "express";
import { describe, expect, it } from "vitest";

import {
  cookieAuthenticator,
  issueCsrfToken,
  issueSessionToken,
  preflightCookieMutation,
  readCookieSession,
  SESSION_COOKIE_NAME,
  sessionClearCookie,
  sessionSetCookie,
  sessionTokenSha256,
  verifyCsrfToken,
  verifyStoredMutationSession,
  type SessionRepository,
  type StoredSession,
} from "../src/auth/cookieSession.js";

const origin = "https://fictional.example";
const token = "a".repeat(43);
const now = 2_000;
const secret = Buffer.alloc(32, 7);
const active: StoredSession = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  householdId: "fictional-household",
  userId: "fictional-adult",
  userStatus: "active",
  sessionAuthVersion: 3,
  userAuthVersion: 3,
  expiresAt: now + 100,
  revokedAt: null,
  csrfSecret: secret,
};

function request(headers: Record<string, string | undefined>): Pick<Request, "get"> {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { get: (name: string) => lower[name.toLowerCase()] } as Pick<Request, "get">;
}

function repository(row: StoredSession | null, onLookup?: (hash: string) => void): SessionRepository {
  return { findByTokenSha256: async (hash) => {
    onLookup?.(hash);
    return row;
  } };
}

const cookie = `${SESSION_COOKIE_NAME}=${token}`;

describe("TypeScript cookie-session boundary", () => {
  it("uses a random URL-safe token and stores only its SHA-256 digest", () => {
    const issued = issueSessionToken();
    expect(issued.plaintext).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.sha256).toBe(createHash("sha256").update(issued.plaintext).digest("hex"));
    expect(sessionTokenSha256(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(sessionSetCookie(token)).toBe(
      `${cookie}; Max-Age=28800; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(sessionClearCookie()).toBe(
      `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(sessionSetCookie(token)).not.toContain("Domain=");
  });

  it("derives identity only from the stored active session and rechecks revocation", async () => {
    let current: StoredSession | null = active;
    const store: SessionRepository = { findByTokenSha256: async () => current };
    const incoming = request({ cookie, authorization: "Bearer invented-user" });
    expect((await readCookieSession(incoming, store, now))?.scope).toEqual({
      householdId: "fictional-household", userId: "fictional-adult",
    });
    current = { ...active, revokedAt: now };
    expect(await readCookieSession(incoming, store, now)).toBeNull();
  });

  it.each([
    { name: "expired", change: { expiresAt: now } },
    { name: "disabled", change: { userStatus: "disabled" as const } },
    { name: "pending", change: { userStatus: "pending" as const } },
    { name: "old auth version", change: { userAuthVersion: 4 } },
    { name: "invalid CSRF secret", change: { csrfSecret: Buffer.alloc(2) } },
  ])("rejects a $name session", async ({ change }) => {
    expect(await readCookieSession(request({ cookie }), repository({ ...active, ...change }), now))
      .toBeNull();
  });

  it("rejects absent, malformed and duplicate cookies before database lookup", async () => {
    let lookups = 0;
    const store = repository(active, () => { lookups += 1; });
    for (const header of [undefined, `${SESSION_COOKIE_NAME}=short`, `${cookie}; ${cookie}`]) {
      expect(await readCookieSession(request({ cookie: header }), store, now)).toBeNull();
    }
    expect(lookups).toBe(0);
  });

  it("uses a per-session HMAC CSRF token compatible with the existing format", () => {
    const issued = issueCsrfToken(active.sessionId, secret);
    expect(issued).toMatch(/^v1\.[A-Za-z0-9_-]{32}\.[0-9a-f]{64}$/);
    expect(verifyCsrfToken(issued, active.sessionId, secret)).toBe(true);
    expect(verifyCsrfToken(issued, "22222222-2222-4222-8222-222222222222", secret)).toBe(false);
    expect(verifyCsrfToken(`${issued}x`, active.sessionId, secret)).toBe(false);
    const nonce = "b".repeat(32);
    const pythonCompatibleMac = createHmac("sha256", secret)
      .update(`v1:${active.sessionId}:${nonce}`).digest("hex");
    expect(verifyCsrfToken(`v1.${nonce}.${pythonCompatibleMac}`, active.sessionId, secret)).toBe(true);
  });

  it("checks exact Origin and Fetch-Site before a mutation touches storage", () => {
    for (const headers of [
      { cookie, origin: undefined },
      { cookie, origin: "https://other.example" },
      { cookie, origin, "sec-fetch-site": "same-site" },
      { cookie, origin, "sec-fetch-site": "cross-site" },
    ]) {
      expect(preflightCookieMutation(request(headers), origin)).toEqual({
        ok: false, status: 403, error: "ORIGIN_NOT_ALLOWED",
      });
    }
  });

  it("separates mutation preflight from in-transaction session and CSRF checks", () => {
    expect(preflightCookieMutation(request({ origin }), origin)).toEqual({
      ok: false, status: 401, error: "AUTH_REQUIRED",
    });
    expect(preflightCookieMutation(request({ origin, cookie }), origin)).toEqual({
      ok: false, status: 403, error: "INVALID_CSRF",
    });
    const csrf = issueCsrfToken(active.sessionId, secret);
    const validHeaders = { origin, cookie, "x-csrf-token": csrf, "sec-fetch-site": "same-origin" };
    const preflight = preflightCookieMutation(request(validHeaders), origin);
    expect(preflight).toEqual({
      ok: true, tokenSha256: sessionTokenSha256(token), csrfToken: csrf,
    });
    expect(verifyStoredMutationSession(active, csrf, now).ok).toBe(true);
    expect(verifyStoredMutationSession(active, "v1.bad.bad", now)).toEqual({
      ok: false, status: 403, error: "INVALID_CSRF",
    });
    expect(verifyStoredMutationSession({ ...active, revokedAt: now }, csrf, now)).toEqual({
      ok: false, status: 401, error: "AUTH_REQUIRED",
    });
  });

  it("provides the existing Express authentication callback shape", async () => {
    const authenticate = cookieAuthenticator(repository({ ...active, expiresAt: Number.MAX_SAFE_INTEGER }));
    expect(await authenticate(request({ cookie }) as Request)).toEqual({
      householdId: "fictional-household", userId: "fictional-adult",
    });
  });
});
