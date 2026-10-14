import { afterEach, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { privatePilotHeaders } from "../src/http/privatePilotHeaders.js";

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
});

it("restricts private HTML/API delivery without allowing inline scripts or framing", async () => {
  const app = express();
  app.use(privatePilotHeaders);
  app.get("/", (_request, response) => { response.send("<html><body>Fictional workspace</body></html>"); });
  server = await new Promise<Server>(resolve => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test port unavailable");
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const policy = response.headers.get("content-security-policy");
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toContain("object-src 'none'");
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
