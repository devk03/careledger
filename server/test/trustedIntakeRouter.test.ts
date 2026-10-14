import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import express from "express";
import { createTrustedIntakeRouter } from "../src/http/trustedIntakeRouter.js";
import type { createTrustedIntake, TrustedIntakeRepository } from "../src/ingest/trustedIntake.js";

const servers: Server[] = [];
const origin = "https://adeno.example.invalid";
const headers = { origin, "content-type": "image/png", "x-upload-name": "Invented%20image.png",
  cookie: `__Host-careledger_session=${"a".repeat(43)}`, "x-csrf-token": "fictional-csrf" };
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function endpoint(upload: ReturnType<typeof createTrustedIntake>, allowed = true) {
  const repository: TrustedIntakeRepository = {
    checkDocumentIntake: () => allowed ? { ok: true } : { ok: false, status: 403, error: "FORBIDDEN" },
    recordInspectedOriginal: () => { throw new Error("HTTP transport must use its intake service"); },
  };
  const app = express();
  app.use(createTrustedIntakeRouter({ expectedOrigin: origin, repository, upload }));
  const server = await new Promise<Server>(resolve => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test port unavailable");
  return `http://127.0.0.1:${address.port}/api/v2/care-profiles/invented-profile/documents`;
}

it("denies Origin/session/CSRF and intake permission failures before uploads", async () => {
  const deniedUpload = async () => { throw new Error("Unauthorized upload must not run"); };
  const url = await endpoint(deniedUpload);
  for (const [candidate, status] of [
    [{ ...headers, origin: "https://attacker.invalid" }, 403],
    [{ ...headers, cookie: "" }, 401], [{ ...headers, "x-csrf-token": "" }, 403],
  ] as const) expect((await fetch(url, { method: "POST", headers: candidate, body: "invented" })).status).toBe(status);
  const forbidden = await endpoint(deniedUpload, false);
  expect((await fetch(forbidden, { method: "POST", headers, body: "invented" })).status).toBe(403);
});

it("passes exact binary bytes and a decoded filename without accepting model-supplied identity", async () => {
  const bytes = Uint8Array.from([0, 1, 2, 255]);
  const url = await endpoint(async input => {
    expect(input.careProfileId).toBe("invented-profile");
    expect(input.originalName).toBe("Invented image.png");
    expect(input.claimedMediaType).toBe("image/png");
    expect(Buffer.from(input.bytes)).toEqual(Buffer.from(bytes));
    expect(input).not.toHaveProperty("householdId");
    return { ok: true, documentId: "invented-document", alreadyExisted: false };
  });
  const response = await fetch(`${url}?householdId=other&userId=owner`, { method: "POST", headers, body: bytes });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ documentId: "invented-document", alreadyExisted: false });
});

it("rejects closed formats, compression and malformed names before buffering", async () => {
  const url = await endpoint(async () => { throw new Error("Invalid upload must not run"); });
  for (const candidate of [
    { ...headers, "content-type": "application/pdf" }, { ...headers, "content-encoding": "gzip" },
  ]) expect((await fetch(url, { method: "POST", headers: candidate, body: "invented" })).status).toBe(415);
  expect((await fetch(url, { method: "POST", headers: { ...headers, "x-upload-name": "%invalid" }, body: "invented" })).status)
    .toBe(400);
});

it("bounds concurrent buffered requests and releases the slot after processing", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const url = await endpoint(async () => {
    entered(); await wait;
    return { ok: true, documentId: "invented-document", alreadyExisted: true };
  });
  const first = fetch(url, { method: "POST", headers, body: "invented" });
  await started;
  expect((await fetch(url, { method: "POST", headers, body: "invented" })).status).toBe(429);
  release(); expect((await first).status).toBe(200);
  expect((await fetch(url, { method: "POST", headers, body: "invented" })).status).toBe(200);
});

it("redacts pipeline diagnostics and does not retain the slot after failure", async () => {
  const url = await endpoint(async () => { throw new Error("private document text and scanner diagnostics"); });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(url, { method: "POST", headers, body: "invented" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "INTAKE_UNAVAILABLE" });
  }
});
