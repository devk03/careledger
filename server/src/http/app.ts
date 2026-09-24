import express, { type Request } from "express";

import { preflightCookieMutation } from "../auth/cookieSession.js";
import type { GrantResult } from "../storage/sqliteFamilyMutations.js";
import {
  getHistoryThroughDay,
  InvalidTimelineDate,
  listTimelineDays,
  TimelineAccessDenied,
} from "../timeline/history.js";
import {
  getApprovedSourcePage,
  InvalidPageRequest,
  SourcePageNotFound,
} from "../timeline/sourcePage.js";
import type { ApprovedPageRepository, AuthorizedScope, TimelineRepository } from "../timeline/types.js";

export type AuthenticateRequest = (request: Request) => Promise<AuthorizedScope | null>;
export type DayAccessWriter = {
  grantDayAccess(input: {
    preflight: { ok: true; tokenSha256: string; csrfToken: string };
    careProfileId: string; careDay: string; subjectUserId: string;
    level: "none" | "view" | "contribute" | "publish"; reason?: string;
  }): GrantResult;
};

/**
 * Transport composition only. Production must inject session authentication and a
 * household-scoped durable repository before this app is exposed to users.
 */
export function createHttpApp(dependencies: {
  authenticate: AuthenticateRequest;
  timeline: TimelineRepository;
  pages: ApprovedPageRepository;
  /** Only pass both fields for the trusted-local v7 family pilot. */
  mutations?: DayAccessWriter;
  expectedOrigin?: string;
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok" });
  });

  if (dependencies.mutations !== undefined && dependencies.expectedOrigin !== undefined) {
    app.post("/api/v2/care-profiles/:careProfileId/timeline/days/:careDay/access",
      express.json({ limit: "16kb", type: "application/json" }), (request, response) => {
        const preflight = preflightCookieMutation(request, dependencies.expectedOrigin!);
        if (!preflight.ok) {
          response.status(preflight.status).json({ error: preflight.error });
          return;
        }
        const body: unknown = request.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          response.status(400).json({ error: "INVALID_BODY" });
          return;
        }
        const fields = body as Record<string, unknown>;
        const subjectUserId = fields.subjectUserId;
        const level = fields.level;
        const reason = fields.reason;
        if (typeof subjectUserId !== "string" || subjectUserId.length < 1 || subjectUserId.length > 64 ||
          !["none", "view", "contribute", "publish"].includes(String(level)) ||
          (reason !== undefined && typeof reason !== "string")) {
          response.status(400).json({ error: "INVALID_BODY" });
          return;
        }
        try {
          const result = dependencies.mutations!.grantDayAccess({
            preflight, careProfileId: request.params.careProfileId,
            careDay: request.params.careDay, subjectUserId,
            level: level as "none" | "view" | "contribute" | "publish",
            ...(reason === undefined ? {} : { reason: reason as string }),
          });
          response.status(result.ok ? 201 : result.status).json(result.ok
            ? { eventId: result.eventId, eventNo: result.eventNo }
            : { error: result.error });
        } catch (error) {
          if (error instanceof RangeError || error instanceof InvalidTimelineDate) {
            response.status(400).json({ error: "INVALID_BODY" });
          } else {
            throw error;
          }
        }
      });
  }

  app.get("/api/v2/care-profiles/:careProfileId/timeline/history", async (request, response) => {
    const scope = await dependencies.authenticate(request);
    if (scope === null) {
      response.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }

    const throughDay = request.query.through;
    const focusFromDay = request.query.from;
    const beforeDay = request.query.before;
    const limit = request.query.limit;
    if (typeof throughDay !== "string" ||
      (focusFromDay !== undefined && typeof focusFromDay !== "string") ||
      (beforeDay !== undefined && typeof beforeDay !== "string") ||
      (limit !== undefined && (typeof limit !== "string" || !/^\d+$/.test(limit)))) {
      response.status(400).json({ error: "INVALID_QUERY" });
      return;
    }

    try {
      const result = await getHistoryThroughDay(dependencies.timeline, scope, {
        careProfileId: request.params.careProfileId,
        throughDay,
        ...(focusFromDay === undefined ? {} : { focusFromDay }),
        ...(beforeDay === undefined ? {} : { beforeDay }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
      response.json(result);
    } catch (error) {
      if (error instanceof TimelineAccessDenied) {
        // Do not reveal whether the profile exists in another family.
        response.status(404).json({ error: "NOT_FOUND" });
      } else if (error instanceof InvalidTimelineDate || error instanceof RangeError) {
        response.status(400).json({ error: "INVALID_QUERY" });
      } else {
        throw error;
      }
    }
  });

  app.get("/api/v2/care-profiles/:careProfileId/timeline/days", async (request, response) => {
    const scope = await dependencies.authenticate(request);
    if (scope === null) {
      response.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    const throughDay = request.query.through;
    const beforeDay = request.query.before;
    const limit = request.query.limit;
    if (typeof throughDay !== "string" ||
      (beforeDay !== undefined && typeof beforeDay !== "string") ||
      (limit !== undefined && (typeof limit !== "string" || !/^\d+$/.test(limit)))) {
      response.status(400).json({ error: "INVALID_QUERY" });
      return;
    }
    try {
      const dayList = await listTimelineDays(dependencies.timeline, scope, {
        careProfileId: request.params.careProfileId,
        throughDay,
        ...(beforeDay === undefined ? {} : { beforeDay }),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
      response.json(dayList);
    } catch (error) {
      if (error instanceof TimelineAccessDenied) {
        response.status(404).json({ error: "NOT_FOUND" });
      } else if (error instanceof InvalidTimelineDate || error instanceof RangeError) {
        response.status(400).json({ error: "INVALID_QUERY" });
      } else {
        throw error;
      }
    }
  });

  app.get("/api/v2/care-profiles/:careProfileId/documents/:documentId/pages/:pageNumber", async (request, response) => {
    const scope = await dependencies.authenticate(request);
    if (scope === null) {
      response.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    const offset = request.query.offset;
    if (!/^\d+$/.test(request.params.pageNumber) ||
      (offset !== undefined && (typeof offset !== "string" || !/^\d+$/.test(offset)))) {
      response.status(400).json({ error: "INVALID_QUERY" });
      return;
    }
    try {
      const page = await getApprovedSourcePage(dependencies.pages, dependencies.timeline, scope, {
        careProfileId: request.params.careProfileId,
        documentId: request.params.documentId,
        pageNumber: Number(request.params.pageNumber),
        ...(offset === undefined ? {} : { offset: Number(offset) }),
      });
      response.json(page);
    } catch (error) {
      if (error instanceof SourcePageNotFound) {
        response.status(404).json({ error: "NOT_FOUND" });
      } else if (error instanceof InvalidPageRequest) {
        response.status(400).json({ error: "INVALID_QUERY" });
      } else {
        throw error;
      }
    }
  });

  return app;
}
