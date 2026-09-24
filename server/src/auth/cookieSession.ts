import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

import type { AuthorizedScope } from "../timeline/types.js";

export const SESSION_COOKIE_NAME = "__Host-careledger_session";
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CSRF_TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{32})\.([0-9a-f]{64})$/;

/** The eventual SQLite adapter must fetch this afresh on every request. */
export type StoredSession = {
  sessionId: string;
  householdId: string;
  userId: string;
  userStatus: "active" | "pending" | "disabled";
  sessionAuthVersion: number;
  userAuthVersion: number;
  expiresAt: number;
  revokedAt: number | null;
  csrfSecret: Uint8Array;
};

export interface SessionRepository {
  findByTokenSha256(tokenSha256: string): Promise<StoredSession | null>;
}

export type VerifiedSession = {
  scope: AuthorizedScope;
  sessionId: string;
  csrfSecret: Uint8Array;
  expiresAt: number;
};

export type MutationDecision =
  | { ok: true; session: VerifiedSession }
  | { ok: false; status: 401 | 403; error: "AUTH_REQUIRED" | "INVALID_CSRF" };

export type MutationPreflight =
  | { ok: true; tokenSha256: string; csrfToken: string }
  | { ok: false; status: 401 | 403; error: "AUTH_REQUIRED" | "ORIGIN_NOT_ALLOWED" | "INVALID_CSRF" };

type HeaderRequest = Pick<Request, "get">;

function sessionCookie(request: HeaderRequest): string | null {
  const raw = request.get("cookie");
  if (!raw) return null;
  let token: string | null = null;
  for (const field of raw.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0) continue;
    const name = field.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    if (token !== null) return null; // Duplicate auth cookies fail closed.
    token = field.slice(separator + 1).trim();
  }
  return token !== null && SESSION_TOKEN_PATTERN.test(token) ? token : null;
}

export function sessionTokenSha256(plaintextToken: string): string {
  if (!SESSION_TOKEN_PATTERN.test(plaintextToken)) throw new Error("Invalid session token format");
  return createHash("sha256").update(plaintextToken, "utf8").digest("hex");
}

/** Compatible with the existing Python cookie-token format. */
export function issueSessionToken(): { plaintext: string; sha256: string } {
  const plaintext = randomBytes(32).toString("base64url");
  return { plaintext, sha256: sessionTokenSha256(plaintext) };
}

/** A server-side session lookup; no role or user ID is accepted from a browser or model. */
export async function readCookieSession(
  request: HeaderRequest,
  repository: SessionRepository,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifiedSession | null> {
  const plaintext = sessionCookie(request);
  if (plaintext === null) return null;
  const row = await repository.findByTokenSha256(sessionTokenSha256(plaintext));
  return activeStoredSession(row, nowSeconds);
}

function activeStoredSession(row: StoredSession | null, nowSeconds: number): VerifiedSession | null {
  if (row === null || row.revokedAt !== null || row.expiresAt <= nowSeconds ||
    row.userStatus !== "active" || row.sessionAuthVersion !== row.userAuthVersion ||
    !Number.isSafeInteger(row.expiresAt) || row.csrfSecret.byteLength !== 32) {
    return null;
  }
  return {
    scope: { householdId: row.householdId, userId: row.userId },
    sessionId: row.sessionId,
    csrfSecret: row.csrfSecret,
    expiresAt: row.expiresAt,
  };
}

export function cookieAuthenticator(repository: SessionRepository):
  (request: Request) => Promise<AuthorizedScope | null> {
  return async (request) => (await readCookieSession(request, repository))?.scope ?? null;
}

export function issueCsrfToken(sessionId: string, secret: Uint8Array): string {
  if (secret.byteLength !== 32) throw new Error("Invalid CSRF secret");
  const nonce = randomBytes(24).toString("base64url");
  const mac = createHmac("sha256", secret).update(`v1:${sessionId}:${nonce}`).digest("hex");
  return `v1.${nonce}.${mac}`;
}

export function verifyCsrfToken(token: string, sessionId: string, secret: Uint8Array): boolean {
  const match = CSRF_TOKEN_PATTERN.exec(token);
  if (match === null || secret.byteLength !== 32) return false;
  const expected = createHmac("sha256", secret)
    .update(`v1:${sessionId}:${match[1]}`).digest();
  const supplied = Buffer.from(match[2]!, "hex");
  return timingSafeEqual(expected, supplied);
}

/**
 * Header/cookie preflight only. expectedOrigin must come from trusted deployment
 * configuration, never Host or forwarded headers. This does not authorize a write.
 */
export function preflightCookieMutation(
  request: HeaderRequest,
  expectedOrigin: string,
): MutationPreflight {
  if (request.get("origin") !== expectedOrigin ||
    ![undefined, "same-origin"].includes(request.get("sec-fetch-site"))) {
    return { ok: false, status: 403, error: "ORIGIN_NOT_ALLOWED" };
  }
  const plaintext = sessionCookie(request);
  if (plaintext === null) return { ok: false, status: 401, error: "AUTH_REQUIRED" };
  const csrf = request.get("x-csrf-token");
  if (!csrf) return { ok: false, status: 403, error: "INVALID_CSRF" };
  return { ok: true, tokenSha256: sessionTokenSha256(plaintext), csrfToken: csrf };
}

/**
 * A write transaction must load the session row by the preflight digest, call
 * this function, and perform the protected mutation before that transaction
 * commits. Never authorize a mutation with an earlier read-only lookup.
 */
export function verifyStoredMutationSession(
  row: StoredSession | null,
  csrfToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): MutationDecision {
  const session = activeStoredSession(row, nowSeconds);
  if (session === null) return { ok: false, status: 401, error: "AUTH_REQUIRED" };
  if (!verifyCsrfToken(csrfToken, session.sessionId, session.csrfSecret)) {
    return { ok: false, status: 403, error: "INVALID_CSRF" };
  }
  return { ok: true, session };
}

export function sessionSetCookie(plaintextToken: string, maxAgeSeconds = 8 * 60 * 60): string {
  if (!SESSION_TOKEN_PATTERN.test(plaintextToken) || !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 || maxAgeSeconds > 8 * 60 * 60) {
    throw new Error("Invalid session cookie input");
  }
  return `${SESSION_COOKIE_NAME}=${plaintextToken}; Max-Age=${maxAgeSeconds}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function sessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}
