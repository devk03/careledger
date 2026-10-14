import express from "express";
import type { AuthenticateRequest } from "./app.js";
import type { OriginalImageRepository } from "../timeline/types.js";
import { readOriginalImage } from "../ingest/readOriginalImage.js";

/** Hash-verified private originals only; no PDF, arbitrary path or public asset serving. */
export function createOriginalImageRouter(input: {
  authenticate: AuthenticateRequest; repository: OriginalImageRepository; objectRoot: string;
}) {
  const router = express.Router(); let active = false;
  router.get("/api/v2/care-profiles/:careProfileId/documents/:documentId/original-image", async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    let ownsSlot = false; let reading = false;
    const release = () => { if (ownsSlot && !reading) { active = false; ownsSlot = false; } };
    try {
      const scope = await input.authenticate(request);
      if (!scope) { response.status(401).json({ error: "AUTH_REQUIRED" }); return; }
      const { careProfileId, documentId } = request.params;
      if (![careProfileId, documentId].every(id => /^[a-zA-Z0-9_-]{1,64}$/.test(id))) {
        response.status(400).json({ error: "INVALID_QUERY" }); return;
      }
      const reference = await input.repository.readOriginalImageReference({ ...scope, careProfileId, documentId });
      if (!reference) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      const expected = request.query.expectedSha256;
      if (expected !== undefined && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))) {
        response.status(400).json({ error: "INVALID_QUERY" }); return;
      }
      if (expected !== undefined && expected !== reference.sourceSha256) {
        response.status(404).json({ error: "NOT_FOUND" }); return;
      }
      if (active) { response.status(503).json({ error: "SOURCE_UNAVAILABLE" }); return; }
      active = true; ownsSlot = true; reading = true;
      response.once("finish", release); response.once("close", release);
      const bytes = await readOriginalImage(input.objectRoot, reference);
      if (response.destroyed) return;
      const current = await input.authenticate(request);
      if (!current || current.userId !== scope.userId || current.householdId !== scope.householdId) {
        response.status(401).json({ error: "AUTH_REQUIRED" }); return;
      }
      const rechecked = await input.repository.readOriginalImageReference({ ...current, careProfileId, documentId });
      if (!rechecked || rechecked.sourceSha256 !== reference.sourceSha256 || rechecked.byteSize !== reference.byteSize || rechecked.mediaType !== reference.mediaType) {
        response.status(404).json({ error: "NOT_FOUND" }); return;
      }
      response.setHeader("Content-Disposition", `inline; filename="original.${reference.mediaType === "image/png" ? "png" : "jpg"}"`);
      response.type(reference.mediaType).send(bytes);
    } catch { response.status(503).json({ error: "SOURCE_UNAVAILABLE" }); }
    finally { reading = false; if (response.writableFinished || response.destroyed || !response.headersSent) release(); }
  });
  return router;
}
