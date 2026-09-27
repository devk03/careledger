import express, { type Request } from "express";

import { preflightCookieMutation } from "../auth/cookieSession.js";
import { ManagedDraftPairBusy, ManagedDraftPairDenied,
  type SqliteDraftPairReservation } from "./sqliteDraftPairReservation.js";

type Action = "reserve" | "bind-intents" | "open-leases";
type Caller = { tokenSha256: string; csrfToken: string };
const ID = /^[0-9a-f]{32}$/u;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
class InvalidDraftBody extends Error {}

/**
 * UNMOUNTED managed draft preflight. A reservation response can be lost, and
 * v10 cannot safely reclaim abandoned leases or ID claims. Do not expose this
 * router publicly until idempotent recovery, storage reconciliation, shared
 * rate limiting and non-day SQL bound-device guards have been reviewed.
 * No medical plaintext, filenames or care dates pass through these routes.
 */
export function createManagedDraftPairRouter(input: {
  expectedOrigin: string;
  service: Pick<SqliteDraftPairReservation,
    "reserve" | "bindIntents" | "openPairedLeases">;
  rateLimit: (request: { tokenSha256: string; remoteAddress: string;
    action: Action }) => boolean | Promise<boolean>;
}) {
  const origin = new URL(input.expectedOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== input.expectedOrigin ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && local)) ||
    typeof input.service?.reserve !== "function" ||
    typeof input.service?.bindIntents !== "function" ||
    typeof input.service?.openPairedLeases !== "function" ||
    typeof input.rateLimit !== "function")
    throw new Error("Invalid managed draft router configuration");

  const router = express.Router();
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.removeHeader("X-Powered-By");
    response.removeHeader("Access-Control-Allow-Origin");
    response.removeHeader("Access-Control-Allow-Credentials");
    if (request.method !== "POST") {
      response.status(405).json({ error: "REQUEST_DENIED" });
      return;
    }
    next();
  });
  const json = express.json({ limit: "2kb", type: "application/json",
    strict: true, inflate: false });

  function post(action: Action, handler: (caller: Caller,
    body: Record<string, unknown>) => unknown) {
    router.post(`/${action}`, async (request, response) => {
      const preflight = preflightCookieMutation(request, input.expectedOrigin);
      if (!preflight.ok) {
        response.status(preflight.status).json({ error: "REQUEST_DENIED" });
        return;
      }
      try {
        if (!await input.rateLimit({ tokenSha256: preflight.tokenSha256,
          remoteAddress: request.socket.remoteAddress ?? "unknown", action })) {
          response.status(429).json({ error: "REQUEST_DENIED" });
          return;
        }
      } catch {
        response.status(503).json({ error: "REQUEST_DENIED" });
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
        if (!plainRecord(body)) {
          response.status(400).json({ error: "INVALID_REQUEST" });
          return;
        }
        try {
          response.status(201).json(await handler({
            tokenSha256: preflight.tokenSha256,
            csrfToken: preflight.csrfToken }, body));
        } catch (caught) {
          if (caught instanceof InvalidDraftBody)
            response.status(400).json({ error: "INVALID_REQUEST" });
          else if (caught instanceof ManagedDraftPairBusy)
            response.status(503).json({ error: "REQUEST_DENIED" });
          else if (caught instanceof ManagedDraftPairDenied)
            response.status(404).json({ error: "REQUEST_DENIED" });
          else response.status(503).json({ error: "REQUEST_DENIED" });
        }
      });
    });
  }

  post("reserve", (caller, body) => {
    if (!exactKeys(body, ["profileId", "scopeId", "keyId", "epoch"]) ||
      !validId(body.profileId) || !validId(body.scopeId) ||
      !validId(body.keyId) || !Number.isSafeInteger(body.epoch) ||
      (body.epoch as number) < 1 || (body.epoch as number) > 0xffffffff)
      throw new InvalidDraftBody();
    return input.service.reserve({ ...caller, profileId: body.profileId,
      scopeId: body.scopeId, keyId: body.keyId,
      epoch: body.epoch as number });
  });

  post("bind-intents", (caller, body) => {
    if (!exactKeys(body, ["reservationId", "content", "metadata"]) ||
      !validId(body.reservationId) || !plainRecord(body.content) ||
      !plainRecord(body.metadata) ||
      !exactKeys(body.content, ["objectId", "plaintextBytes"]) ||
      !exactKeys(body.metadata, ["objectId", "plaintextBytes"]) ||
      !validId(body.content.objectId) ||
      !validId(body.metadata.objectId) ||
      body.content.objectId === body.metadata.objectId ||
      !validBytes(body.content.plaintextBytes, MAX_CONTENT_BYTES) ||
      !validBytes(body.metadata.plaintextBytes, MAX_METADATA_BYTES))
      throw new InvalidDraftBody();
    return input.service.bindIntents({ ...caller,
      reservationId: body.reservationId,
      content: { objectId: body.content.objectId,
        plaintextBytes: body.content.plaintextBytes },
      metadata: { objectId: body.metadata.objectId,
        plaintextBytes: body.metadata.plaintextBytes } });
  });

  post("open-leases", (caller, body) => {
    if (!exactKeys(body, ["reservationId"]) ||
      !validId(body.reservationId)) throw new InvalidDraftBody();
    return input.service.openPairedLeases({ ...caller,
      reservationId: body.reservationId });
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
  const sorted = [...expected].sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function validBytes(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 &&
    (value as number) <= maximum;
}
