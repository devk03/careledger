import type { Server } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { createPublicShellApp, PublicShellUnavailable } from
  "../src/publicShell.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) =>
    server.close(() => resolve()))));
});

function fictionalDist(options: { missingAsset?: boolean;
  missingTransitiveAsset?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "adeno-public-shell-fictional-"));
  mkdirSync(join(root, "assets"));
  mkdirSync(join(root, ".vite"));
  writeFileSync(join(root, "index.html"), '<!doctype html><html><head>' +
    '<link rel="stylesheet" href="/assets/index-ABCDEFGH.css"></head>' +
    '<body><div id="root"></div>' +
    '<script type="module" src="/assets/index-ABCDEFGH.js"></script>' +
    '</body></html>');
  writeFileSync(join(root, "assets", "index-ABCDEFGH.js"),
    'document.getElementById("root").textContent="Fictional public shell";');
  if (!options.missingAsset)
    writeFileSync(join(root, "assets", "index-ABCDEFGH.css"),
      "body{color:#241b17}");
  if (!options.missingTransitiveAsset)
    writeFileSync(join(root, "assets", "notes-ABCDEFGH.webp"),
      "fictional image");
  writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify({
    "index.html": { file: "assets/index-ABCDEFGH.js",
      css: ["assets/index-ABCDEFGH.css"],
      assets: ["assets/notes-ABCDEFGH.webp"] },
  }));
  writeFileSync(join(root, "assets", "oldbuild-ABCDEFGH.js"),
    "fictional stale bundle");
  writeFileSync(join(root, "outside"), "fictional private sentinel");
  symlinkSync(join(root, "outside"), join(root, "assets", "leak-ABCDEFGH.js"));
  return root;
}

async function endpoint(root: string) {
  const app = createPublicShellApp(root);
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return `http://127.0.0.1:${address.port}`;
}

it("serves only public pages and hashed assets with no record or auth API", async () => {
  const base = await endpoint(fictionalDist());
  for (const path of ["/", "/about", "/privacy"]) {
    const response = await fetch(`${base}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy"))
      .toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy"))
      .toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security"))
      .toBe("max-age=31536000");
    expect(response.headers.get("x-powered-by")).toBeNull();
  }
  for (const path of ["/login", "/setup", "/recover", "/records",
    "/workspace", "/backup", "/mcp", "/api/v2/auth/login",
    "/api/managed/auth/login", "/api/records", "/unknown"]) {
    const response = await fetch(`${base}${path}`);
    expect(response.status, path).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  for (const path of ["/", "/api/managed/auth/login", "/records"]) {
    const response = await fetch(`${base}${path}`, { method: "POST",
      body: "fictional record", headers: { "content-type": "text/plain" } });
    expect(response.status, path).toBe(404);
    expect((await response.text())).not.toContain("fictional record");
  }
  const asset = await fetch(`${base}/assets/index-ABCDEFGH.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control"))
    .toBe("public, max-age=31536000, immutable");
  expect((await asset.text())).toContain("Fictional public shell");
  const ready = await fetch(`${base}/health/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ status: "ready",
    capability: "public_pages_only", record_intake: false });
  const runtime = await fetch(`${base}/api/public/runtime`);
  expect(await runtime.json()).toEqual({ mode: "public_shell",
    restricted_preview: true, record_uploads_enabled: false,
    managed_e2ee_enabled: false });
});

it("does not serve symlinks, dotfiles, unreviewed images or encoded traversal", async () => {
  const base = await endpoint(fictionalDist());
  for (const path of ["/assets/leak-ABCDEFGH.js",
    "/assets/oldbuild-ABCDEFGH.js", "/assets/.private",
    "/images/garden-640.webp", "/assets/%2e%2e%2foutside",
    "/images/%2e%2e%2foutside", "/assets/index-ABCDEFGH.js.map"]) {
    const response = await fetch(`${base}${path}`);
    expect(response.status, path).toBe(404);
    expect((await response.text())).not.toContain("private sentinel");
  }
});

it("reports public-shell readiness unavailable when a referenced asset is missing", async () => {
  const root = fictionalDist({ missingAsset: true });
  const base = await endpoint(root);
  const ready = await fetch(`${base}/health/ready`);
  expect(ready.status).toBe(503);
  expect(await ready.json()).toEqual({ status: "unavailable",
    capability: "public_pages_only", record_intake: false });
  expect((await fetch(base)).status).toBe(503);
  expect(() => createPublicShellApp("relative/path"))
    .toThrow(PublicShellUnavailable);
  const transitive = await endpoint(fictionalDist({ missingTransitiveAsset: true }));
  expect((await fetch(`${transitive}/health/ready`)).status).toBe(503);
  expect((await fetch(transitive)).status).toBe(503);
});
