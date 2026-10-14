import express, { type RequestHandler, type ErrorRequestHandler } from "express";
import { z } from "zod";
import { preflightCookieMutation } from "../auth/cookieSession.js";
import type { SqliteFamilyMutations } from "../storage/sqliteFamilyMutations.js";
import { parseISODate } from "../timeline/history.js";
import type { DocumentDayReviewRepository, DocumentInboxRepository } from "../timeline/types.js";
import type { AuthenticateRequest } from "./app.js";

const id = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);
const proposalBody = z.object({ careDay: z.string().length(10) }).strict();
const reviewBody = z.object({ decision: z.enum(["accepted", "rejected"]),
  expectedDayRevision: z.number().int().min(0), reason: z.string().trim().min(1).max(2000).optional() }).strict();

/** Browser editorial actions only. Never expose these as MCP mutation tools. */
export function createDocumentDayRouter(input: {
  expectedOrigin: string;
  writer: Pick<SqliteFamilyMutations, "proposeDocumentDay" | "reviewDocumentDay">;
  reviews?: { authenticate: AuthenticateRequest; repository: DocumentDayReviewRepository };
  inbox?: { authenticate: AuthenticateRequest; repository: DocumentInboxRepository };
}) {
  const router = express.Router();
  router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  if (input.inbox) router.get("/api/v2/care-profiles/:careProfileId/documents/inbox", async (request, response) => {
    try {
      const scope = await input.inbox!.authenticate(request);
      if (!scope) { response.status(401).json({ error: "AUTH_REQUIRED" }); return; }
      const profile = id.safeParse(request.params.careProfileId);
      const timestamp = request.query.beforeUploadedAt; const document = request.query.beforeDocumentId;
      let before: { uploadedAt: number; documentId: string } | undefined;
      if (timestamp !== undefined || document !== undefined) {
        if (typeof timestamp !== "string" || !/^[1-9]\d{0,15}$/.test(timestamp) ||
          !Number.isSafeInteger(Number(timestamp)) || !id.safeParse(document).success) {
          response.status(400).json({ error: "INVALID_QUERY" }); return;
        }
        before = { uploadedAt: Number(timestamp), documentId: document as string };
      }
      if (!profile.success) { response.status(400).json({ error: "INVALID_QUERY" }); return; }
      response.json(await input.inbox!.repository.listDocumentInbox({ ...scope, careProfileId: profile.data,
        ...(before === undefined ? {} : { before }) }));
    } catch { response.status(503).json({ error: "DOCUMENT_WORKFLOW_UNAVAILABLE" }); }
  });
  if (input.reviews) router.get("/api/v2/care-profiles/:careProfileId/reviews/document-days/:revisionId", async (request, response) => {
    try {
      const scope = await input.reviews!.authenticate(request);
      if (!scope) { response.status(401).json({ error: "AUTH_REQUIRED" }); return; }
      const profile = id.safeParse(request.params.careProfileId); const revision = id.safeParse(request.params.revisionId);
      if (!profile.success || !revision.success) { response.status(400).json({ error: "INVALID_QUERY" }); return; }
      const result = await input.reviews!.repository.readPendingDocumentDay({ ...scope,
        careProfileId: profile.data, revisionId: revision.data });
      if (!result) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.json(result);
    } catch { response.status(503).json({ error: "DOCUMENT_WORKFLOW_UNAVAILABLE" }); }
  });
  const preflight: RequestHandler = (request, response, next) => {
    const result = preflightCookieMutation(request, input.expectedOrigin);
    if (!result.ok) { response.status(result.status).json({ error: result.error }); return; }
    next();
  };
  const json = express.json({ limit: "4kb", inflate: false, type: "application/json" });
  router.post("/api/v2/care-profiles/:careProfileId/documents/:documentId/day-proposals", preflight, json,
    (request, response) => {
      const authority = preflightCookieMutation(request, input.expectedOrigin);
      if (!authority.ok) { response.status(authority.status).json({ error: authority.error }); return; }
      const body = proposalBody.safeParse(request.body);
      const profile = id.safeParse(request.params.careProfileId); const document = id.safeParse(request.params.documentId);
      if (!body.success || !profile.success || !document.success) {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      try { parseISODate(body.data.careDay); }
      catch { response.status(400).json({ error: "INVALID_BODY" }); return; }
      try {
        const result = input.writer.proposeDocumentDay({ preflight: authority,
          careProfileId: profile.data, documentId: document.data, careDay: body.data.careDay });
        response.status(result.ok ? 201 : result.status).json(result.ok ? result : { error: result.error });
      } catch { response.status(503).json({ error: "DOCUMENT_WORKFLOW_UNAVAILABLE" }); }
    });
  router.post("/api/v2/care-profiles/:careProfileId/timeline/document-days/:revisionId/review", preflight, json,
    (request, response) => {
      const authority = preflightCookieMutation(request, input.expectedOrigin);
      if (!authority.ok) { response.status(authority.status).json({ error: authority.error }); return; }
      const body = reviewBody.safeParse(request.body);
      const profile = id.safeParse(request.params.careProfileId); const revision = id.safeParse(request.params.revisionId);
      if (!body.success || !profile.success || !revision.success) {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      try {
        const result = input.writer.reviewDocumentDay({ preflight: authority,
          careProfileId: profile.data, revisionId: revision.data, decision: body.data.decision,
          expectedDayRevision: body.data.expectedDayRevision,
          ...(body.data.reason === undefined ? {} : { reason: body.data.reason }) });
        response.status(result.ok ? 200 : result.status).json(result.ok ? result : { error: result.error });
      } catch { response.status(503).json({ error: "DOCUMENT_WORKFLOW_UNAVAILABLE" }); }
    });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const type = (error && typeof error === "object" && "type" in error) ? error.type : undefined;
    response.status(type === "entity.too.large" ? 413 : type === "encoding.unsupported" ? 415 : 400)
      .json({ error: "INVALID_BODY" });
  };
  router.use(errors);
  return router;
}
