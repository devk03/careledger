import { createHmac } from "node:crypto";

import express, { type Request } from "express";

const TOKEN = /^[0-9a-f]{64}$/u;
const HOUSEHOLD_ID = /^[0-9a-f]{32}$/u;

type VerificationLimit = { action: "verify-ip" | "verify-token";
  remoteAddress: string; tokenBucket?: string };

export interface ManagedEmailVerificationService {
  /**
   * Atomically activate once for an unexpired, recipient-bound proof. A retry
   * after a committed-but-lost response must return the same validated receipt
   * for a short documented window, without repeating activation. Return null
   * for unknown/expired proofs. Validate the household ID before commit.
   */
  consumeOrReadReceipt(token: string):
    Promise<{ householdId: string } | null>;
}

/**
 * UNMOUNTED transport only. A future service must issue/send high-entropy
 * proofs, persist only hashes, enforce one-use/expiry and activate the exact
 * pending account/family in one transaction. This router cannot supply those
 * guarantees and must not be mounted against a mock or v10 identity database.
 */
export function createManagedEmailVerificationRouter(input: {
  expectedOrigin: string;
  verification: ManagedEmailVerificationService;
  /** Injected deployment bucket key; the raw bearer token is never logged. */
  bucketKey: Uint8Array;
  rateLimit: (input: VerificationLimit) => boolean | Promise<boolean>;
}) {
  const parsed = new URL(input.expectedOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.origin !== input.expectedOrigin ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && local)) ||
    !input.verification ||
    typeof input.verification.consumeOrReadReceipt !== "function" ||
    !(input.bucketKey instanceof Uint8Array) ||
    input.bucketKey.byteLength !== 32 ||
    typeof input.rateLimit !== "function")
    throw new Error("Invalid managed email verification configuration");
  const bucketKey = Buffer.from(input.bucketKey);
  const router = express.Router();
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.removeHeader("X-Powered-By");
    response.removeHeader("Access-Control-Allow-Origin");
    response.removeHeader("Access-Control-Allow-Credentials");
    if (request.path === "/verify-email" && request.method !== "POST") {
      response.status(405).json({ error: "REQUEST_DENIED" });
      return;
    }
    next();
  });
  const json = express.json({ limit: "256b", type: "application/json",
    strict: true, inflate: false });
  async function allowed(request: Request, action: VerificationLimit["action"],
    tokenBucket?: string): Promise<"allow" | "deny" | "unavailable"> {
    try {
      const decision = await input.rateLimit({ action,
        remoteAddress: request.socket.remoteAddress ?? "unknown",
        ...(tokenBucket ? { tokenBucket } : {}) });
      return decision ? "allow" : "deny";
    } catch { return "unavailable"; }
  }
  router.post("/verify-email", async (request, response) => {
    if (request.get("origin") !== input.expectedOrigin ||
      ![undefined, "same-origin"].includes(request.get("sec-fetch-site"))) {
      response.status(403).json({ error: "REQUEST_DENIED" });
      return;
    }
    const ip = await allowed(request, "verify-ip");
    if (ip !== "allow") {
      response.status(ip === "deny" ? 429 : 503)
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
      if (!plainRecord(body) || !exactKeys(body, ["token"]) ||
        typeof body.token !== "string" || !TOKEN.test(body.token)) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      const tokenBucket = createHmac("sha256", bucketKey)
        .update(body.token, "ascii").digest("hex");
      const tokenLimit = await allowed(request, "verify-token", tokenBucket);
      if (tokenLimit !== "allow") {
        response.status(tokenLimit === "deny" ? 429 : 503)
          .json({ error: "REQUEST_DENIED" });
        return;
      }
      try {
        const result = await input.verification.consumeOrReadReceipt(body.token);
        if (!result) {
          response.status(202).json({ accepted: true });
        } else if (typeof result.householdId === "string" &&
          HOUSEHOLD_ID.test(result.householdId)) {
          // A committed proof (or its idempotent receipt) yields the opaque
          // family ID needed for login, never a login session or token.
          response.status(200).json({ verified: true,
            householdId: result.householdId });
        } else {
          response.status(503).json({ error: "REQUEST_DENIED" });
        }
      } catch {
        response.status(503).json({ error: "REQUEST_DENIED" });
      }
    });
  });
  router.use((_error: unknown, _request: Request, response: express.Response,
    _next: express.NextFunction) => {
    if (!response.headersSent)
      response.status(400).json({ error: "INVALID_REQUEST" });
  });
  return router;
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
