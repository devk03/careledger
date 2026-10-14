import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createHttpApp } from "../src/http/app.js";
import type { SqliteFamilyMutations } from "../src/storage/sqliteFamilyMutations.js";

const servers: Server[] = [];
const origin = "https://adeno.example.invalid";
const token = "A".repeat(43);
const headers = { origin, "content-type": "application/json",
  cookie: `__Host-careledger_session=${token}`, "x-csrf-token": "fictional-csrf" };
it("keeps document workflow capability disabled by default and requires authentication", async () => {
  const app = createHttpApp({ authenticate: async request => request.get("authorization") === "Bearer fictional-owner"
    ? { householdId: "family-a", userId: "owner-a" } : null,
    timeline: { profileBelongsToHousehold: async () => false, listApprovedDays: async () => [] },
    pages: { readApprovedPageChunk: async () => null } });
  const server = await new Promise<Server>(resolve => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  servers.push(server); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic endpoint unavailable");
  const url = `http://127.0.0.1:${address.port}/api/v2/document-workflow/capabilities`;
  expect((await fetch(url)).status).toBe(401);
  const response = await fetch(url, { headers: { authorization: "Bearer fictional-owner" } });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ available: false });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
});
async function endpoint(profileWriter: Pick<SqliteFamilyMutations, "createCareProfile">) {
  const app = createHttpApp({ authenticate: async () => null,
    timeline: { profileBelongsToHousehold: async () => false, listApprovedDays: async () => [] },
    pages: { readApprovedPageChunk: async () => null }, profileWriter, expectedOrigin: origin });
  const server = await new Promise<Server>(resolve => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test port unavailable");
  return `http://127.0.0.1:${address.port}/api/v2/care-profiles`;
}

it("rejects missing session, wrong origin and missing CSRF before any profile write", async () => {
  const url = await endpoint({ createCareProfile: () => { throw new Error("Must not write"); } });
  for (const [candidate, expected] of [
    [{ origin, "content-type": "application/json" }, 401],
    [{ ...headers, origin: "https://attacker.invalid" }, 403],
    [{ ...headers, "x-csrf-token": "" }, 403],
  ] as const) {
    const response = await fetch(url, { method: "POST", headers: candidate,
      body: JSON.stringify({ preferredName: "Invented person" }) });
    expect(response.status).toBe(expected);
  }
});

it("passes only a server-derived session digest and name, ignoring spoofed authority", async () => {
  const url = await endpoint({ createCareProfile: input => {
    expect(input).toEqual({ preferredName: "Invented person", preflight: {
      ok: true, csrfToken: "fictional-csrf",
      tokenSha256: createHash("sha256").update(token).digest("hex"),
    } });
    return { ok: true, id: "profile-a", preferredName: "Invented person" };
  } });
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({
    preferredName: "Invented person", householdId: "other-family", userId: "owner", role: "owner",
  }) });
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ profile: { id: "profile-a", preferredName: "Invented person" } });
});

it("preserves transaction authorization denial and validates the request body", async () => {
  const url = await endpoint({ createCareProfile: () => ({ ok: false, status: 403, error: "FORBIDDEN" }) });
  expect((await fetch(url, { method: "POST", headers,
    body: JSON.stringify({ preferredName: "Invented person" }) })).status).toBe(403);
  for (const body of [null, [], {}, { preferredName: 1 }]) {
    expect((await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })).status).toBe(400);
  }
});
