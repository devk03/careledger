import express from "express";
import { preflightCookieMutation } from "../auth/cookieSession.js";
import { MAX_UPLOAD_BYTES } from "../ingest/admission.js";
import type { createTrustedIntake, TrustedIntakeRepository } from "../ingest/trustedIntake.js";

/** One bounded request body at a time; authorization precedes body buffering. */
export function createTrustedIntakeRouter(input: {
  expectedOrigin: string; repository: TrustedIntakeRepository;
  upload: ReturnType<typeof createTrustedIntake>;
}) {
  const router = express.Router();
  const body = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES, inflate: false });
  let occupied = false;
  router.post("/api/v2/care-profiles/:careProfileId/documents", (request, response) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) { response.status(preflight.status).json({ error: preflight.error }); return; }
    const careProfileId = request.params.careProfileId;
    const authorization = input.repository.checkDocumentIntake({ preflight, careProfileId });
    if (!authorization.ok) { response.status(authorization.status).json({ error: authorization.error }); return; }
    if (occupied) { response.status(429).json({ error: "INTAKE_BUSY" }); return; }
    const claimedMediaType = request.get("content-type") ?? "";
    if (!["image/png", "image/jpeg"].includes(claimedMediaType) || request.get("content-encoding")) {
      response.status(415).json({ error: "UNSUPPORTED_TYPE" }); return;
    }
    const encodedName = request.get("x-upload-name");
    let originalName: string;
    try {
      if (!encodedName || encodedName.length > 1620) throw new Error("Invalid name");
      originalName = decodeURIComponent(encodedName);
      if (!originalName.trim() || originalName.length > 180) throw new Error("Invalid name");
    } catch { response.status(400).json({ error: "INVALID_UPLOAD_NAME" }); return; }
    occupied = true;
    let processing = false;
    let released = false;
    const release = () => { if (!released) { released = true; occupied = false; } };
    response.once("close", () => { if (!processing) release(); });
    body(request, response, error => {
      if (error) {
        release();
        const tooLarge = typeof error === "object" && error !== null && "type" in error &&
          error.type === "entity.too.large";
        response.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD" });
        return;
      }
      if (request.aborted || response.destroyed) { release(); return; }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        release(); response.status(400).json({ error: "INVALID_UPLOAD" }); return;
      }
      processing = true;
      void input.upload({ preflight, careProfileId, originalName, claimedMediaType, bytes: request.body })
        .then(result => {
          if (response.destroyed) return;
          response.setHeader("Cache-Control", "no-store");
          response.status(result.ok ? result.alreadyExisted ? 200 : 201 : result.status)
            .json(result.ok ? { documentId: result.documentId, alreadyExisted: result.alreadyExisted }
              : { error: result.error });
        }).catch(() => {
          if (!response.destroyed) response.status(503).json({ error: "INTAKE_UNAVAILABLE" });
        }).finally(release);
    });
  });
  return router;
}
