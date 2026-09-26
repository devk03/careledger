import { createHmac } from "node:crypto";

import express, { type Request } from "express";

import { cookieSessionTokenSha256, preflightCookieMutation,
  sessionClearCookie, sessionSetCookie } from "../auth/cookieSession.js";
import type { SqliteManagedIdentityCandidate } from
  "./sqliteManagedIdentity.js";
import { normalizeManagedEmail } from "./sqliteManagedIdentity.js";

type Action = "login-ip" | "login-credential";
type ManagedIdentity = Pick<SqliteManagedIdentityCandidate,
  "login" | "readSession" | "logout">;
type LimiterInput = { action: Action; remoteAddress: string;
  tokenSha256?: string; credentialBucket?: string };
const ID = /^[0-9a-f]{32}$/u;

/**
 * UNMOUNTED managed-v10 auth router. It does not offer public registration or
 * activation. Mount only after a real shared limiter, verified-email lifecycle,
 * secure origin/reverse-proxy policy, and human device approval are reviewed.
 */
export function createManagedAuthRouter(input: {
  expectedOrigin: string;
  identity: ManagedIdentity;
  /** Separate deployment secret; never expose or reuse an API/signing key. */
  credentialBucketKey: Uint8Array;
  rateLimit: (input: LimiterInput) => boolean | Promise<boolean>;
}) {
  const parsed = new URL(input.expectedOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"]
    .includes(parsed.hostname);
  if (parsed.origin !== input.expectedOrigin ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && local)) ||
    !(input.credentialBucketKey instanceof Uint8Array) ||
    input.credentialBucketKey.byteLength !== 32 ||
    typeof input.rateLimit !== "function")
    throw new Error("Invalid managed auth router configuration");
  const bucketKey = Buffer.from(input.credentialBucketKey);

  const router = express.Router();
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.removeHeader("X-Powered-By");
    response.removeHeader("Access-Control-Allow-Origin");
    response.removeHeader("Access-Control-Allow-Credentials");
    const methods: Record<string, string> = {
      "/login": "POST", "/session": "GET", "/logout": "POST",
    };
    if (methods[request.path] && methods[request.path] !== request.method) {
      response.status(405).json({ error: "REQUEST_DENIED" });
      return;
    }
    next();
  });

  async function limited(request: Request, action: Action,
    tokenSha256?: string, credentialBucket?: string):
    Promise<"allow" | "deny" | "unavailable"> {
    try {
      const allowed = await input.rateLimit({ action,
        remoteAddress: request.socket.remoteAddress ?? "unknown",
        ...(tokenSha256 ? { tokenSha256 } : {}),
        ...(credentialBucket ? { credentialBucket } : {}) });
      return allowed ? "allow" : "deny";
    } catch { return "unavailable"; }
  }

  const json = express.json({ limit: "2kb", type: "application/json",
    strict: true, inflate: false });

  router.post("/login", async (request, response) => {
    if (!sameOrigin(request, input.expectedOrigin)) {
      response.status(403).json({ error: "REQUEST_DENIED" });
      return;
    }
    const limit = await limited(request, "login-ip");
    if (limit !== "allow") {
      response.status(limit === "deny" ? 429 : 503)
        .json({ error: "REQUEST_DENIED" });
      return;
    }
    if (!request.is("application/json") ||
      ![undefined, "identity"].includes(request.get("content-encoding")) ||
      request.body !== undefined) {
      response.status(400).json({ error: "INVALID_REQUEST" });
      return;
    }
    json(request, response, async (error?: unknown) => {
      if (error) {
        const status = typeof error === "object" && error !== null &&
          "type" in error && error.type === "entity.too.large" ? 413 : 400;
        response.status(status).json({ error: "INVALID_REQUEST" });
        return;
      }
      const body: unknown = request.body;
      if (!plainRecord(body) ||
        !exactKeys(body, ["email", "householdId", "password"]) ||
        typeof body.email !== "string" || body.email.length > 254 ||
        typeof body.password !== "string" || body.password.length > 128 ||
        typeof body.householdId !== "string" || !ID.test(body.householdId)) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      let credentialBucket: string;
      try {
        const normalized = normalizeManagedEmail(body.email);
        credentialBucket = createHmac("sha256", bucketKey)
          .update(normalized, "utf8").digest("hex");
      } catch {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      const credentialLimit = await limited(request, "login-credential",
        undefined, credentialBucket);
      if (credentialLimit !== "allow") {
        response.status(credentialLimit === "deny" ? 429 : 503)
          .json({ error: "REQUEST_DENIED" });
        return;
      }
      try {
        const login = await input.identity.login({ email: body.email,
          password: body.password, householdId: body.householdId });
        response.setHeader("Set-Cookie", sessionSetCookie(login.sessionToken));
        // Explicit projection: never serialize the cookie token, even if its
        // service property later becomes enumerable.
        response.status(200).json({ householdId: login.householdId,
          accountId: login.accountId, sessionId: login.sessionId,
          csrfToken: login.csrfToken, expiresAt: login.expiresAt,
          role: login.role, memberKind: login.memberKind });
      } catch {
        response.status(403).json({ error: "REQUEST_DENIED" });
      }
    });
  });

  router.get("/session", async (request, response) => {
    if (!sameOriginRead(request, input.expectedOrigin)) {
      response.status(403).json({ error: "REQUEST_DENIED" });
      return;
    }
    if (hasBody(request)) {
      response.status(400).json({ error: "INVALID_REQUEST" });
      return;
    }
    const tokenSha256 = cookieSessionTokenSha256(request);
    if (!tokenSha256) {
      response.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    // Session recovery must remain available after a reload so a family can
    // retrieve its CSRF token and revoke the cookie during limiter outages.
    // The random cookie lookup is cheap; ingress still needs an abuse policy.
    let session;
    try { session = input.identity.readSession(tokenSha256); }
    catch {
      response.status(503).json({ error: "REQUEST_DENIED" });
      return;
    }
    if (!session) {
      response.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    response.status(200).json({ householdId: session.householdId,
      accountId: session.accountId, sessionId: session.sessionId,
      csrfToken: session.csrfToken, expiresAt: session.expiresAt,
      role: session.role, memberKind: session.memberKind });
  });

  router.post("/logout", async (request, response) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) {
      response.status(preflight.status).json({ error: "REQUEST_DENIED" });
      return;
    }
    if (hasBody(request)) {
      response.status(400).json({ error: "INVALID_REQUEST" });
      return;
    }
    try {
      input.identity.logout(preflight);
      response.setHeader("Set-Cookie", sessionClearCookie());
      response.status(204).end();
    } catch {
      response.status(403).json({ error: "REQUEST_DENIED" });
    }
  });

  // Never allow default Express diagnostics to echo a password or cookie.
  router.use((_error: unknown, _request: Request, response: express.Response,
    _next: express.NextFunction) => {
    if (!response.headersSent)
      response.status(400).json({ error: "INVALID_REQUEST" });
  });
  return router;
}

function sameOrigin(request: Request, expected: string): boolean {
  return request.get("origin") === expected &&
    [undefined, "same-origin"].includes(request.get("sec-fetch-site"));
}

function sameOriginRead(request: Request, expected: string): boolean {
  const origin = request.get("origin");
  const site = request.get("sec-fetch-site");
  return (origin === expected && [undefined, "same-origin"].includes(site)) ||
    (origin === undefined && site === "same-origin");
}

function hasBody(request: Request): boolean {
  const lengths = request.rawHeaders.filter((_value, index) => index % 2 === 0)
    .filter((name) => name.toLowerCase() === "content-length");
  return request.body !== undefined || lengths.length > 1 ||
    request.get("transfer-encoding") !== undefined ||
    (request.get("content-length") !== undefined &&
      request.get("content-length") !== "0");
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}
