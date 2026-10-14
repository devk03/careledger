import express from "express";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createOriginalImageRouter } from "../src/http/originalImageRouter.js";

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-original-read-"));
  const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: "#173951" } }).png().toBuffer();
  const reference = { sourceSha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length, mediaType: "image/png" as const };
  const shard = join(root, reference.sourceSha256.slice(0, 2), reference.sourceSha256.slice(2, 4));
  await mkdir(shard, { recursive: true, mode: 0o700 });
  const path = join(shard, reference.sourceSha256); await writeFile(path, bytes, { mode: 0o400 });
  return { root, bytes, reference, path, shard };
}
async function endpoint(input: Parameters<typeof createOriginalImageRouter>[0]) {
  const app = express(); app.use(createOriginalImageRouter(input));
  const server = await new Promise<Server>(resolve => { const started = app.listen(0, "127.0.0.1", () => resolve(started)); });
  servers.push(server); const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic endpoint unavailable");
  return `http://127.0.0.1:${address.port}/api/v2/care-profiles/profile-a/documents/document-a/original-image`;
}
const scope = { householdId: "family-a", userId: "owner-a" };
const headers = { authorization: "Bearer fictional-owner" };

it("returns exact generated original bytes with private image headers after both authority checks", async () => {
  const state = await fixture(); let reads = 0;
  const url = await endpoint({ objectRoot: state.root, authenticate: async request => request.get("authorization") ? scope : null,
    repository: { readOriginalImageReference: async input => {
      reads++; expect(input).toEqual({ ...scope, careProfileId: "profile-a", documentId: "document-a" }); return state.reference;
    } } });
  expect((await fetch(url)).status).toBe(401); expect(reads).toBe(0);
  const response = await fetch(`${url}?userId=other&householdId=other`, { headers });
  expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(state.bytes); expect(reads).toBe(2);
});

it("withholds bytes when the session or source grant is revoked during a read", async () => {
  const state = await fixture();
  for (const revokeSession of [true, false]) {
    let authentications = 0; let reads = 0;
    const url = await endpoint({ objectRoot: state.root,
      authenticate: async () => { authentications++; return revokeSession && authentications > 1 ? null : scope; },
      repository: { readOriginalImageReference: async () => { reads++; return reads > 1 ? null : state.reference; } } });
    const response = await fetch(url, { headers }); expect(response.status).toBe(revokeSession ? 401 : 404);
    expect(await response.json()).toEqual({ error: revokeSession ? "AUTH_REQUIRED" : "NOT_FOUND" });
  }
});

it("fails closed on tampering, symlinked originals and unsafe directory permissions", async () => {
  for (const failure of ["tamper", "symlink", "permissions"] as const) {
    const state = await fixture();
    if (failure === "permissions") await chmod(state.shard, 0o755);
    else {
      const preserved = join(state.root, "preserved-original"); await rename(state.path, preserved);
      if (failure === "symlink") await symlink(preserved, state.path);
      else { const changed = Buffer.from(state.bytes); changed[changed.length - 1]! ^= 1; await writeFile(state.path, changed, { mode: 0o400 }); }
    }
    const url = await endpoint({ objectRoot: state.root, authenticate: async () => scope,
      repository: { readOriginalImageReference: async () => state.reference } });
    const response = await fetch(url, { headers }); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "SOURCE_UNAVAILABLE" });
  }
});

it("denies another original while the first read awaits its final authority check, then releases the slot", async () => {
  const state = await fixture(); let calls = 0;
  let reached!: () => void; const checking = new Promise<void>(resolve => { reached = resolve; });
  let release!: (value: typeof scope) => void; const authority = new Promise<typeof scope>(resolve => { release = resolve; });
  const url = await endpoint({ objectRoot: state.root, authenticate: async () => {
    if (++calls === 2) { reached(); return authority; } return scope;
  }, repository: { readOriginalImageReference: async () => state.reference } });
  const first = fetch(url, { headers }); await checking;
  try { expect((await fetch(url, { headers })).status).toBe(503); }
  finally { release(scope); }
  expect((await first).status).toBe(200);
  expect((await fetch(url, { headers })).status).toBe(200);
});
