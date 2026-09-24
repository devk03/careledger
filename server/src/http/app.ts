import express, { type Request } from "express";

import { issueCsrfToken, preflightCookieMutation, readCookieSession,
  sessionClearCookie, sessionSetCookie, type SessionRepository } from "../auth/cookieSession.js";
import type { SqliteFamilyAccounts } from "../auth/familyAccounts.js";
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
  accounts?: SqliteFamilyAccounts;
  sessions?: SessionRepository;
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

  if (dependencies.accounts !== undefined && dependencies.sessions !== undefined &&
    dependencies.expectedOrigin !== undefined) {
    const accounts = dependencies.accounts;
    const expectedOrigin = dependencies.expectedOrigin;
    const json = express.json({ limit: "16kb", type: "application/json" });
    const sameOrigin = (request: Request): boolean =>
      request.get("origin") === expectedOrigin &&
      [undefined, "same-origin"].includes(request.get("sec-fetch-site"));

    app.get("/api/v2/auth/session", async (request, response) => {
      const session = await readCookieSession(request, dependencies.sessions!);
      if (!session) { response.status(401).json({ error: "AUTH_REQUIRED" }); return; }
      response.json({ userId: session.scope.userId, householdId: session.scope.householdId,
        csrfToken: issueCsrfToken(session.sessionId, session.csrfSecret), expiresAt: session.expiresAt });
    });

    app.post("/api/v2/auth/login", json, async (request, response) => {
      if (!sameOrigin(request)) { response.status(403).json({ error: "ORIGIN_NOT_ALLOWED" }); return; }
      const body: unknown = request.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      const fields = body as Record<string, unknown>;
      if (typeof fields.loginName !== "string" || typeof fields.password !== "string") {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      const result = await accounts.login({ loginName: fields.loginName, password: fields.password });
      if (!result.ok) {
        response.status(result.error === "TRY_LATER" ? 429 : result.error === "INVALID_INPUT" ? 400 : 401)
          .json({ error: result.error });
        return;
      }
      response.setHeader("Set-Cookie", sessionSetCookie(result.value.sessionToken));
      const { sessionToken: _secret, ...publicResult } = result.value;
      response.json(publicResult);
    });

    app.post("/api/v2/auth/invitations/accept", json, async (request, response) => {
      if (!sameOrigin(request)) { response.status(403).json({ error: "ORIGIN_NOT_ALLOWED" }); return; }
      const body: unknown = request.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      const fields = body as Record<string, unknown>;
      if (typeof fields.token !== "string" || typeof fields.loginName !== "string" ||
        typeof fields.displayName !== "string" || typeof fields.password !== "string") {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      const result = await accounts.acceptInvitation({ token: fields.token,
        loginName: fields.loginName, displayName: fields.displayName, password: fields.password });
      if (!result.ok) {
        response.status(result.error === "LOGIN_TAKEN" ? 409 : 400).json({ error: result.error });
        return;
      }
      response.setHeader("Set-Cookie", sessionSetCookie(result.value.sessionToken));
      const { sessionToken: _secret, ...publicResult } = result.value;
      response.status(201).json(publicResult);
    });

    app.post("/api/v2/auth/invitations", json, (request, response) => {
      const preflight = preflightCookieMutation(request, expectedOrigin);
      if (!preflight.ok) { response.status(preflight.status).json({ error: preflight.error }); return; }
      const body: unknown = request.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      const kind = (body as Record<string, unknown>).memberKind;
      if (kind !== "adult" && kind !== "child") {
        response.status(400).json({ error: "INVALID_BODY" }); return;
      }
      const result = accounts.issueInvitation(preflight, kind);
      response.status(result.ok ? 201 : result.error === "AUTH_REQUIRED" ? 401 : 403)
        .json(result.ok ? result.value : { error: result.error });
    });

    app.post("/api/v2/auth/logout", (request, response) => {
      const preflight = preflightCookieMutation(request, expectedOrigin);
      if (!preflight.ok) { response.status(preflight.status).json({ error: preflight.error }); return; }
      const result = accounts.logout(preflight);
      if (!result.ok) {
        response.status(result.error === "AUTH_REQUIRED" ? 401 : 403).json({ error: result.error });
        return;
      }
      response.setHeader("Set-Cookie", sessionClearCookie());
      response.status(204).end();
    });
  }

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
