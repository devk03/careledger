import express, { type Request } from "express";

import { preflightCookieMutation, readCookieSession,
  verifyStoredMutationSession, type SessionRepository } from "../auth/cookieSession.js";
import type { AuthorizedScope } from "../timeline/types.js";

const MEDIA_TYPE = "application/vnd.adeno.vault.v1";
const MAX_CANARY_WIRE_BYTES = 64 * 1024;
const HEADER_BYTES = 33;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHUNK_BYTES = 1024 * 1024;
const MAGIC = Buffer.from("ADEN", "ascii");
const ROUTE = "/__canary/vault/blobs/:blobId";
const OPAQUE_ID = /^[0-9a-f]{32}$/;

/** Ephemeral test repository only. No production storage implementation exists. */
export interface SyntheticVaultCanaryStore {
  create(input: { scope: AuthorizedScope; blobId: string; wire: Buffer }): "stored" | "exists";
  read(input: { scope: AuthorizedScope; blobId: string }): Buffer | null;
}

function validWire(bytes: Buffer): string | null {
  if (bytes.length < HEADER_BYTES + IV_BYTES + 4 + TAG_BYTES ||
    bytes.length > MAX_CANARY_WIRE_BYTES || !bytes.subarray(0, 4).equals(MAGIC) ||
    bytes[4] !== 1) return null;
  const plaintextSize = bytes.readUInt32BE(21);
  const chunkSize = bytes.readUInt32BE(25);
  const chunkCount = bytes.readUInt32BE(29);
  if (chunkSize !== CHUNK_BYTES || plaintextSize > MAX_CANARY_WIRE_BYTES ||
    chunkCount !== Math.max(1, Math.ceil(plaintextSize / CHUNK_BYTES))) return null;
  let offset = HEADER_BYTES;
  for (let index = 0; index < chunkCount; index += 1) {
    if (offset + IV_BYTES + 4 > bytes.length) return null;
    offset += IV_BYTES;
    const size = bytes.readUInt32BE(offset);
    offset += 4;
    const expected = Math.max(0, Math.min(CHUNK_BYTES,
      plaintextSize - index * CHUNK_BYTES)) + TAG_BYTES;
    if (size !== expected || offset + size > bytes.length) return null;
    offset += size;
  }
  return offset === bytes.length ? bytes.subarray(5, 21).toString("hex") : null;
}

function routeId(request: Request): string | null {
  const value = request.params.blobId;
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}

/**
 * Synthetic-only HTTP transfer canary. Never import this from a runtime entrypoint:
 * it has no durable storage, day grants, device keys, or backup/restore.
 */
export function createSyntheticVaultCanaryApp(input: {
  sessions: SessionRepository;
  expectedOrigin: string;
  store: SyntheticVaultCanaryStore;
}) {
  if (process.env.NODE_ENV !== "test") throw new Error("SYNTHETIC_CANARY_TEST_ONLY");
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.post(ROUTE, (request, response, next) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) {
      response.status(preflight.status).json({ error: preflight.error });
      return;
    }
    if (request.get("content-type") !== MEDIA_TYPE) {
      response.status(415).json({ error: "INVALID_WIRE" });
      return;
    }
    const lengths = request.rawHeaders.filter((value) => value.toLowerCase() === "content-length");
    const declared = request.get("content-length");
    if (lengths.length > 1 || (declared !== undefined &&
      (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_CANARY_WIRE_BYTES))) {
      response.status(413).json({ error: "INVALID_WIRE" });
      return;
    }
    response.locals.preflight = preflight;
    next();
  }, express.raw({ type: MEDIA_TYPE, limit: MAX_CANARY_WIRE_BYTES, inflate: false }),
  async (request, response) => {
    const blobId = routeId(request);
    const wire = request.body;
    if (!blobId || !Buffer.isBuffer(wire) || validWire(wire) !== blobId) {
      response.status(400).json({ error: "INVALID_WIRE" });
      return;
    }
    const preflight = response.locals.preflight as {
      tokenSha256: string; csrfToken: string;
    };
    const session = verifyStoredMutationSession(
      await input.sessions.findByTokenSha256(preflight.tokenSha256), preflight.csrfToken);
    if (!session.ok) {
      response.status(session.status).json({ error: session.error });
      return;
    }
    // The test store is synchronous: no await separates current auth from write.
    const result = input.store.create({ scope: session.session.scope,
      blobId, wire: Buffer.from(wire) });
    response.status(result === "stored" ? 201 : 409)
      .json({ status: result === "stored" ? "stored" : "exists" });
  });

  app.get(ROUTE, async (request, response) => {
    const session = await readCookieSession(request, input.sessions);
    if (!session) { response.status(401).json({ error: "AUTH_REQUIRED" }); return; }
    const blobId = routeId(request);
    const wire = blobId ? input.store.read({ scope: session.scope, blobId }) : null;
    if (!wire) { response.status(404).json({ error: "NOT_FOUND" }); return; }
    response.setHeader("Content-Type", MEDIA_TYPE);
    response.status(200).send(Buffer.from(wire));
  });

  app.use((_request, response) => { response.status(404).json({ error: "NOT_FOUND" }); });
  app.use((error: unknown, _request: Request, response: express.Response,
    _next: express.NextFunction) => {
    const status = error && typeof error === "object" && "status" in error
      ? error.status : undefined;
    if (status === 413 || status === 400) {
      response.status(status).json({ error: "INVALID_WIRE" });
      return;
    }
    response.status(500).json({ error: "UNAVAILABLE" });
  });
  return app;
}
