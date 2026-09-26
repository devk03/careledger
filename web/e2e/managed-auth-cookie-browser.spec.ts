import { createServer, type Server } from "node:http";

import { expect, test } from "@playwright/test";

test("Chromium keeps a fictional managed session cookie HttpOnly on loopback", async ({ page }) => {
  const token = "a".repeat(43);
  const cookieName = "__Host-careledger_session";
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Fictional managed cookie test</title>");
    } else if (request.url === "/login" && request.method === "POST") {
      response.setHeader("Set-Cookie", `${cookieName}=${token}; ` +
        "Max-Age=28800; Path=/; Secure; HttpOnly; SameSite=Strict");
      response.statusCode = 204;
      response.end();
    } else if (request.url === "/session") {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ hasCookie: request.headers.cookie
        ?.includes(`${cookieName}=${token}`) ?? false }));
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fictional test port");
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const result = await page.evaluate(async () => {
      const login = await fetch("/login", { method: "POST",
        credentials: "same-origin" });
      const session = await fetch("/session", { credentials: "same-origin" });
      return { loginStatus: login.status,
        session: await session.json() as { hasCookie: boolean },
        scriptCookie: document.cookie };
    });
    expect(result.loginStatus).toBe(204);
    expect(result.session).toEqual({ hasCookie: true });
    expect(result.scriptCookie).not.toContain(cookieName);
  } finally {
    await new Promise<void>((resolve) => (server as Server).close(() => resolve()));
  }
});
