import { createHash } from "node:crypto";

import { encodePendingDraftPairActionPayloadV1,
  PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1,
  type PendingDraftPairActionContextV1 } from "@adeno/contracts";
import express, { type Request } from "express";

import { preflightCookieMutation } from "../auth/cookieSession.js";
import { ManagedPendingDraftPairDenied,
  ManagedPendingDraftPairUnavailable } from
  "./sqlitePendingDraftPairWriter.js";
import type { SignedPendingDraftPairActionRow } from
  "./verifyPendingDraftPairAction.js";

type Caller = { tokenSha256: string; csrfToken: string };
type Submission = Caller & { context: PendingDraftPairActionContextV1;
  action: SignedPendingDraftPairActionRow };
const DECIMAL = /^[1-9][0-9]{0,18}$/u;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const CONTEXT_KEYS = ["householdId", "careProfileId", "opaqueDraftScopeId",
  "keyId", "reservationId", "contentIntentId", "metadataIntentId",
  "contentBlobId", "metadataBlobId", "contentObjectId",
  "metadataObjectId", "authorDeviceId", "sessionId", "keyEpoch",
  "authorCounter", "pairedAt", "contentWireBytes", "metadataWireBytes",
  "keyCommitmentSha256", "activeKeyHeadSha256", "grantHeadSha256",
  "contentWireSha256", "metadataWireSha256", "previousActionSha256",
  "issuerSigningKeySha256"];
class InvalidPairBody extends Error {}

/**
 * UNMOUNTED v10 route. JSON carries opaque signed claims, never document
 * plaintext. The server derives both digests from the canonical payload and
 * the submitted signature; the transactional writer verifies authority.
 * Do not mount until schema, lease recovery and audit-preimage gates pass.
 */
export function createManagedPendingDraftPairRouter(input: {
  expectedOrigin: string;
  submit: (submission: Submission) =>
    { status: "pending"; reservationId: string; pairSha256: string } |
    Promise<{ status: "pending"; reservationId: string;
      pairSha256: string }>;
  rateLimit: (request: { tokenSha256: string; remoteAddress: string }) =>
    boolean | Promise<boolean>;
}) {
  const origin = new URL(input.expectedOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== input.expectedOrigin ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && local)) ||
    typeof input.submit !== "function" ||
    typeof input.rateLimit !== "function")
    throw new Error("Invalid pending pair router configuration");
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
  const json = express.json({ limit: "4kb", type: "application/json",
    strict: true, inflate: false });
  router.post("/submit", async (request, response) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) {
      response.status(preflight.status).json({ error: "REQUEST_DENIED" });
      return;
    }
    try {
      if (!await input.rateLimit({ tokenSha256: preflight.tokenSha256,
        remoteAddress: request.socket.remoteAddress ?? "unknown" })) {
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
      try {
        const parsed = parseSubmission(request.body);
        const result = await input.submit({
          tokenSha256: preflight.tokenSha256,
          csrfToken: preflight.csrfToken, ...parsed });
        response.status(201).json(result);
      } catch (caught) {
        if (caught instanceof InvalidPairBody)
          response.status(400).json({ error: "INVALID_REQUEST" });
        else if (caught instanceof ManagedPendingDraftPairDenied)
          response.status(404).json({ error: "REQUEST_DENIED" });
        else if (caught instanceof ManagedPendingDraftPairUnavailable)
          response.status(503).json({ error: "RETRY_SAME_SUBMISSION" });
        else response.status(503).json({ error: "REQUEST_DENIED" });
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

function parseSubmission(value: unknown): Pick<Submission, "context" | "action"> {
  if (!plainRecord(value) || !exactKeys(value, ["context", "signature"]) ||
    !plainRecord(value.context) ||
    !exactKeys(value.context, CONTEXT_KEYS) ||
    typeof value.signature !== "string" ||
    !SIGNATURE.test(value.signature)) throw new InvalidPairBody();
  const wireContext = value.context;
  if (typeof wireContext.authorCounter !== "string" ||
    !DECIMAL.test(wireContext.authorCounter) ||
    typeof wireContext.pairedAt !== "string" ||
    !DECIMAL.test(wireContext.pairedAt)) throw new InvalidPairBody();
  const context = { ...wireContext,
    authorCounter: BigInt(wireContext.authorCounter),
    pairedAt: BigInt(wireContext.pairedAt) } as PendingDraftPairActionContextV1;
  let payload: Uint8Array;
  try { payload = encodePendingDraftPairActionPayloadV1(context); }
  catch { throw new InvalidPairBody(); }
  const signature = Buffer.from(value.signature, "base64");
  if (signature.length !== 64 ||
    signature.toString("base64") !== value.signature)
    throw new InvalidPairBody();
  const sha256 = (bytes: Uint8Array): string =>
    createHash("sha256").update(bytes).digest("hex");
  const action: SignedPendingDraftPairActionRow = {
    householdId: context.householdId,
    deviceId: context.authorDeviceId,
    counter: context.authorCounter,
    actionKind: "review",
    payloadSha256: sha256(payload),
    previousActionSha256: context.previousActionSha256,
    actionSha256: sha256(Buffer.concat([
      Buffer.from(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
      Buffer.from(payload), signature])),
    signature,
    createdAt: context.pairedAt,
  };
  return { context, action };
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
