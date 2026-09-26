import express, { type Request } from "express";
import { parseDeviceEnrollmentProofWireV1,
  parseSessionDeviceProofWireV1 } from "@adeno/contracts";

import { preflightCookieMutation } from "../auth/cookieSession.js";
import type { SqliteDeviceEnrollmentCandidate } from
  "./sqliteDeviceEnrollment.js";
import type { SqliteSessionDeviceBindingCandidate } from
  "./sqliteSessionDeviceBinding.js";

type Preflight = { tokenSha256: string; csrfToken: string };
type Action = "enrollment-challenge" | "enrollment-proof" |
  "binding-challenge" | "binding-proof";
const ID = /^[0-9a-f]{32}$/u;
const KEY = /^[0-9a-f]{64}$/u;
class InvalidManagedBody extends Error {}

export type ManagedDeviceRouterDependencies = {
  /** Fixed deployment configuration; never a forwarded/request host. */
  expectedOrigin: string;
  enrollment: Pick<SqliteDeviceEnrollmentCandidate, "issueWire" | "proveWire">;
  binding: Pick<SqliteSessionDeviceBindingCandidate, "issueWire" | "bindWire">;
  /** Required external/distributed abuse decision. Fail closed on errors. */
  rateLimit: (input: { tokenSha256: string; remoteAddress: string;
    action: Action }) =>
    boolean | Promise<boolean>;
};

/**
 * UNMOUNTED managed-only router. Mount under /api/managed/device only after
 * managed login, human device approval, origin/CORS and rate-limit deployment
 * review. It handles opaque IDs and key proofs, never medical content.
 */
export function createManagedDeviceRouter(deps: ManagedDeviceRouterDependencies) {
  const origin = new URL(deps.expectedOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== deps.expectedOrigin ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && local)) ||
    typeof deps.rateLimit !== "function")
    throw new Error("Invalid managed device router configuration");

  const router = express.Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.removeHeader("X-Powered-By");
    response.removeHeader("Access-Control-Allow-Origin");
    response.removeHeader("Access-Control-Allow-Credentials");
    if (_request.method !== "POST") {
      response.status(405).json({ error: "REQUEST_DENIED" });
      return;
    }
    next();
  });

  const json = express.json({ limit: "2kb", type: "application/json",
    strict: true, inflate: false });

  function post(action: Action, handler: (input: Preflight,
    body: Record<string, unknown>) => { status: 201 | 204; value?: unknown },
  ) {
    router.post(`/${action}`, async (request, response) => {
      const preflight = preflightCookieMutation(request, deps.expectedOrigin);
      if (!preflight.ok) {
        response.status(preflight.status).json({ error: "REQUEST_DENIED" });
        return;
      }
      try {
        if (!await deps.rateLimit({ tokenSha256: preflight.tokenSha256,
          remoteAddress: request.socket.remoteAddress ?? "unknown", action })) {
          response.status(429).json({ error: "REQUEST_DENIED" });
          return;
        }
      } catch {
        response.status(503).json({ error: "REQUEST_DENIED" });
        return;
      }
      if (!request.is("application/json")) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      if (![undefined, "identity"].includes(request.get("content-encoding"))) {
        response.status(415).json({ error: "INVALID_REQUEST" });
        return;
      }
      // An upstream parser could otherwise bypass this route's 2 KB limit.
      // Managed composition must mount this router before any body parser.
      if (request.body !== undefined) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      json(request, response, (error?: unknown) => {
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
          const result = handler({ tokenSha256: preflight.tokenSha256,
            csrfToken: preflight.csrfToken }, body);
          if (result.status === 204) response.status(204).end();
          else response.status(201).json(result.value);
        } catch (error) {
          if (error instanceof InvalidManagedBody)
            response.status(400).json({ error: "INVALID_REQUEST" });
          else response.status(403).json({ error: "REQUEST_DENIED" });
        }
      });
    });
  }

  post("enrollment-challenge", (preflight, body) => {
    if (!exactKeys(body, ["encryptionPublicKeyHex", "signingPublicKeyHex"]) ||
      typeof body.encryptionPublicKeyHex !== "string" ||
      !KEY.test(body.encryptionPublicKeyHex) ||
      typeof body.signingPublicKeyHex !== "string" ||
      !KEY.test(body.signingPublicKeyHex))
      throw new InvalidManagedBody();
    return { status: 201, value: deps.enrollment.issueWire({ ...preflight,
      encryptionPublicKeyHex: body.encryptionPublicKeyHex,
      signingPublicKeyHex: body.signingPublicKeyHex }) };
  });

  post("enrollment-proof", (preflight, body) => {
    if (!exactKeys(body, ["proof"]))
      throw new InvalidManagedBody();
    try { parseDeviceEnrollmentProofWireV1(body.proof); }
    catch { throw new InvalidManagedBody(); }
    return { status: 201, value: deps.enrollment.proveWire({ ...preflight,
      proof: body.proof }) };
  });

  post("binding-challenge", (preflight, body) => {
    if (!exactKeys(body, ["deviceId"]) ||
      typeof body.deviceId !== "string" || !ID.test(body.deviceId))
      throw new InvalidManagedBody();
    return { status: 201, value: deps.binding.issueWire({ ...preflight,
      deviceId: body.deviceId }) };
  });

  post("binding-proof", (preflight, body) => {
    if (!exactKeys(body, ["proof"]))
      throw new InvalidManagedBody();
    try { parseSessionDeviceProofWireV1(body.proof); }
    catch { throw new InvalidManagedBody(); }
    deps.binding.bindWire({ ...preflight, proof: body.proof });
    return { status: 204 };
  });

  // The JSON parser's diagnostics must never include submitted key/proof data.
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
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}
