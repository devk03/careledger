import { McpServer, createMcpHandler, type AuthInfo } from
  "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import express, { type Request } from "express";
import { z } from "zod/v4";

const ID = /^[0-9a-f]{32}$/u;
const TOKEN = /^[A-Za-z0-9._~-]{16,2048}$/u;
const HANDLE = /^[A-Za-z0-9_-]{8,40}$/u;
const SCOPE = "mcp:profile";

export type FictionalApprovedMcpConnection = {
  subjectId: string;
  approvedBySubjectId: string;
  subjectHandle: string;
  clientId: string;
  resource: string;
  scopes: string[];
  memberKind: "adult" | "child";
  role: "owner" | "adult" | "child";
  membershipActive: boolean;
  grantActive: boolean;
  approvedAt: number;
  expiresAt: number;
};

/**
 * UNMOUNTED, FICTIONAL-LOCAL transport proof only. The verifier must model a
 * fresh per-request adult consent/membership/revocation lookup. It is not an
 * OAuth server, not backed by durable grants, and never exposes medical tools.
 * Production must add OAuth discovery, a real consent UI and durable revocation
 * before a separate managed composition may mount an MCP endpoint.
 */
export function createFictionalConnectionProfileMcpRouter(input: {
  expectedOrigin: string;
  verify: (token: string) =>
    FictionalApprovedMcpConnection | null |
    Promise<FictionalApprovedMcpConnection | null>;
  rateLimit: (remoteAddress: string) => boolean | Promise<boolean>;
  now?: () => number;
}) {
  const origin = new URL(input.expectedOrigin);
  if (process.env.NODE_ENV === "production" ||
    process.env.VITEST !== "true" || origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.origin !== input.expectedOrigin ||
    typeof input.verify !== "function" ||
    typeof input.rateLimit !== "function")
    throw new Error("Fictional MCP transport requires localhost test mode");
  const resource = `${input.expectedOrigin}/mcp`;
  const sdk = createMcpHandler(({ authInfo }) => {
    const subjectHandle = authInfo?.extra?.subjectHandle;
    if (typeof subjectHandle !== "string" || !HANDLE.test(subjectHandle))
      throw new Error("Missing approved fictional MCP principal");
    const server = new McpServer({ name: "adeno", version: "0.1.0" });
    server.registerTool("get_connection_profile", {
      description: "Confirm this fictional MCP connection only. No family records or medical data are available through this tool.",
      inputSchema: z.object({}),
    }, async () => ({ content: [{ type: "text", text: JSON.stringify({
      connected: true, scope: SCOPE, subject: subjectHandle,
      private_records_available: false,
    }) }] }));
    return server;
  }, { legacy: "stateless" });
  const node = toNodeHandler(sdk);
  const router = express.Router();
  const json = express.json({ limit: "16kb", type: "application/json",
    strict: true, inflate: false });
  router.use((request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.removeHeader("X-Powered-By");
    response.removeHeader("Access-Control-Allow-Origin");
    response.removeHeader("Access-Control-Allow-Credentials");
    if (!loopback(request.socket.localAddress) ||
      !loopback(request.socket.remoteAddress) ||
      request.get("host") !== origin.host ||
      (request.get("origin") !== undefined &&
        request.get("origin") !== input.expectedOrigin)) {
      response.status(403).json({ error: "REQUEST_DENIED" });
      return;
    }
    if (request.path !== "/" || request.originalUrl.includes("?")) {
      response.status(404).json({ error: "REQUEST_DENIED" });
      return;
    }
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      response.status(405).json({ error: "REQUEST_DENIED" });
      return;
    }
    next();
  });
  router.all("/", async (request, response) => {
    try {
      if (!await input.rateLimit(request.socket.remoteAddress ?? "unknown")) {
        response.status(429).json({ error: "REQUEST_DENIED" });
        return;
      }
    } catch {
      response.status(503).json({ error: "REQUEST_DENIED" });
      return;
    }
    const authHeaders = request.rawHeaders.filter((_, index) =>
      index % 2 === 0 &&
      request.rawHeaders[index]?.toLowerCase() === "authorization");
    const match = /^Bearer ([^\s]+)$/iu.exec(request.get("authorization") ?? "");
    if (authHeaders.length !== 1 || !match || !TOKEN.test(match[1]!) ||
      request.get("cookie") !== undefined) {
      unauthorized(response);
      return;
    }
    let grant: FictionalApprovedMcpConnection | null;
    try { grant = await input.verify(match[1]!); }
    catch {
      response.status(503).json({ error: "REQUEST_DENIED" });
      return;
    }
    const now = input.now?.() ?? Math.floor(Date.now() / 1000);
    if (!validGrant(grant, resource, now)) {
      unauthorized(response);
      return;
    }
    if (request.method === "POST") {
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
        if (request.body === undefined) {
          response.status(400).json({ error: "INVALID_REQUEST" });
          return;
        }
        await serve(request, response, grant!, request.body);
      });
    } else {
      if (request.get("content-length") !== undefined ||
        request.get("transfer-encoding") !== undefined) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      await serve(request, response, grant);
    }
  });
  async function serve(request: Request, response: express.Response,
    grant: FictionalApprovedMcpConnection, body?: unknown): Promise<void> {
    const auth: AuthInfo = { token: "fictional-validated-token",
      clientId: grant.clientId, scopes: [SCOPE], expiresAt: grant.expiresAt,
      resource: new URL(resource),
      extra: { subjectHandle: grant.subjectHandle } };
    (request as Request & { auth: AuthInfo }).auth = auth;
    await node(request, response, body);
  }
  return { router, close: () => sdk.close() };
}

function validGrant(value: FictionalApprovedMcpConnection | null,
  resource: string, now: number): value is FictionalApprovedMcpConnection {
  return value !== null && typeof value === "object" &&
    ID.test(value.subjectId) &&
    value.approvedBySubjectId === value.subjectId &&
    HANDLE.test(value.subjectHandle) &&
    typeof value.clientId === "string" &&
    /^[A-Za-z0-9._~-]{8,100}$/u.test(value.clientId) &&
    value.resource === resource && Array.isArray(value.scopes) &&
    value.scopes.length === 1 && value.scopes[0] === SCOPE &&
    value.memberKind === "adult" &&
    (value.role === "owner" || value.role === "adult") &&
    value.membershipActive === true && value.grantActive === true &&
    Number.isSafeInteger(value.approvedAt) && value.approvedAt > 0 &&
    value.approvedAt <= now && Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > now && value.expiresAt <= now + 3600;
}

function unauthorized(response: express.Response): void {
  response.setHeader("WWW-Authenticate", 'Bearer realm="adeno-mcp"');
  response.status(401).json({ error: "AUTH_REQUIRED" });
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" ||
    address === "::ffff:127.0.0.1";
}
