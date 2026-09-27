import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";

import express from "express";

import { PublicProjectStatsCache } from "./publicProjectStats.js";

const ASSET = /^[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2|webp|svg)$/u;
const INDEX_ASSET = /(?:src|href)="(\/assets\/[^"?#]+)"/gu;
const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self'",
  "img-src 'self'", "font-src 'self'", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  "object-src 'none'"].join("; ");

export class PublicShellUnavailable extends Error {
  constructor() {
    super("Public-only shell assets are unavailable.");
    this.name = "PublicShellUnavailable";
  }
}

/** Public pages only. Never compose this with the pilot or managed record API. */
export function createPublicShellApp(distRoot: string) {
  const root = validateRoot(distRoot);
  const project = new PublicProjectStatsCache();
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.setHeader("Content-Security-Policy", CSP);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
    response.setHeader("Permissions-Policy",
      "camera=(), microphone=(), geolocation=()");
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok", capability: "public_pages_only" });
  });
  app.get("/health/ready", (_request, response) => {
    const ready = assetsReady(root);
    response.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "unavailable",
      capability: "public_pages_only", record_intake: false,
    });
  });
  app.get("/api/public/runtime", (_request, response) => {
    response.json({ mode: "public_shell", restricted_preview: true,
      record_uploads_enabled: false, managed_e2ee_enabled: false });
  });
  app.get("/api/public/project", async (_request, response) => {
    response.json(await project.read());
  });

  for (const path of ["/", "/about", "/privacy"]) {
    app.get(path, (_request, response) => {
      if (!assetsReady(root)) {
        response.status(503).json({ error: "PUBLIC_SHELL_UNAVAILABLE" });
        return;
      }
      response.type("html");
      response.sendFile(join(root, "index.html"));
    });
  }
  app.get("/assets/:file", (request, response) => {
    const file = request.params.file;
    const allowed = manifestAssets(root);
    if (!ASSET.test(file) || !allowed?.has(`assets/${file}`) ||
      !safeFile(root, join(root, "assets", file))) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.sendFile(join(root, "assets", file));
  });
  app.use((_request, response) => {
    response.status(404).json({ error: "NOT_FOUND" });
  });
  return app;
}

function validateRoot(value: string): string {
  try {
    if (typeof value !== "string" || !isAbsolute(value))
      throw new PublicShellUnavailable();
    const info = lstatSync(value);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new PublicShellUnavailable();
    return realpathSync(value);
  } catch { throw new PublicShellUnavailable(); }
}

function safeFile(root: string, path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const real = realpathSync(path);
    return real.startsWith(`${root}${sep}`);
  } catch { return false; }
}

function assetsReady(root: string): boolean {
  const indexPath = join(root, "index.html");
  if (!safeFile(root, indexPath)) return false;
  try {
    const allowed = manifestAssets(root);
    if (!allowed || allowed.size === 0 || !Array.from(allowed).every((asset) =>
      safeFile(root, join(root, asset)))) return false;
    const index = readFileSync(indexPath, "utf8");
    const assets = Array.from(index.matchAll(INDEX_ASSET),
      (match) => match[1] ?? "");
    return assets.length > 0 && assets.every((reference) => {
      const file = reference.slice("/assets/".length);
      return ASSET.test(file) && allowed.has(`assets/${file}`);
    });
  } catch { return false; }
}

/** Vite's current manifest is the only asset allowlist; stale builds stay inert. */
function manifestAssets(root: string): Set<string> | null {
  const path = join(root, ".vite", "manifest.json");
  if (!safeFile(root, path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const assets = new Set<string>();
    for (const value of Object.values(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
      const entry = value as Record<string, unknown>;
      for (const field of ["file", "css", "assets"] as const) {
        const paths = field === "file" ? [entry[field]] : entry[field] ?? [];
        if (!Array.isArray(paths)) return null;
        for (const asset of paths) {
          if (typeof asset !== "string" || !asset.startsWith("assets/") ||
            !ASSET.test(asset.slice("assets/".length))) return null;
          assets.add(asset);
        }
      }
    }
    return assets;
  } catch { return null; }
}
