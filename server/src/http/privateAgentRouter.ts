import express from "express";
import { preflightCookieMutation, type SessionRepository } from "../auth/cookieSession.js";
import type { PrivateAgentGrantStore } from "../auth/privateAgentGrants.js";
import type { SqliteFamilyMutations } from "../storage/sqliteFamilyMutations.js";

export const AGENT_CONSENT = "approved_history_and_sources_v1";

/** Human browser action only. These approval/revocation endpoints are not MCP tools. */
export function createPrivateAgentRouter(input: {
  expectedOrigin: string; authority: Pick<SqliteFamilyMutations, "authorizeAgentConnection">;
  grants: Pick<PrivateAgentGrantStore, "issue" | "revoke">;
  inventory?: { grants: Pick<PrivateAgentGrantStore, "listOwned">; sessions: SessionRepository };
}) {
  const router = express.Router();
  router.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  const json = express.json({ limit: "4kb", inflate: false, type: "application/json" });
  if (input.inventory) {
    router.post("/api/v2/agent-connections/list", async (request, response) => {
      const preflight = preflightCookieMutation(request, input.expectedOrigin);
      if (!preflight.ok) { response.status(preflight.status).json({ error: preflight.error }); return; }
      const owner = input.authority.authorizeAgentConnection(preflight);
      if (!owner.ok) { response.status(owner.status).json({ error: owner.error }); return; }
      try {
        response.json({ connections: await input.inventory!.grants.listOwned(owner.owner, input.inventory!.sessions) });
      } catch { response.status(503).json({ error: "CONNECTION_UNAVAILABLE" }); }
    });
  }
  router.post("/api/v2/agent-connections", json, async (request, response) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) { response.status(preflight.status).json({ error: preflight.error }); return; }
    const body: unknown = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body) ||
      (body as Record<string, unknown>).consent !== AGENT_CONSENT) {
      response.status(400).json({ error: "EXPLICIT_APPROVAL_REQUIRED" }); return;
    }
    const approved = input.authority.authorizeAgentConnection(preflight);
    if (!approved.ok) { response.status(approved.status).json({ error: approved.error }); return; }
    let issuedId: string | undefined;
    try {
      const grant = await input.grants.issue(approved.owner);
      issuedId = grant.grantId;
      const current = input.authority.authorizeAgentConnection(preflight);
      if (!current.ok || current.owner.sessionId !== approved.owner.sessionId ||
        current.owner.userId !== approved.owner.userId || current.owner.householdId !== approved.owner.householdId) {
        await input.grants.revoke(grant.grantId, approved.owner);
        response.status(401).json({ error: "AUTH_REQUIRED" }); return;
      }
      response.status(201).json({ ...grant, transport: "ssh_stdio", scopes: ["approved_history:read", "approved_source:read"],
        storagePrivacy: "trusted_server_readable", selectedClientReceivesPlaintext: true });
    } catch {
      if (issuedId) { try { await input.grants.revoke(issuedId, approved.owner); } catch { /* Reads still recheck live authority. */ } }
      response.status(503).json({ error: "CONNECTION_UNAVAILABLE" });
    }
  });
  router.post("/api/v2/agent-connections/:grantId/disconnect", async (request, response) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) { response.status(preflight.status).json({ error: preflight.error }); return; }
    const owner = input.authority.authorizeAgentConnection(preflight);
    if (!owner.ok) { response.status(owner.status).json({ error: owner.error }); return; }
    try {
      const revoked = await input.grants.revoke(request.params.grantId, owner.owner);
      if (!revoked) { response.status(404).json({ error: "NOT_FOUND" }); return; }
      response.status(204).end();
    } catch { response.status(503).json({ error: "CONNECTION_UNAVAILABLE" }); }
  });
  return router;
}
