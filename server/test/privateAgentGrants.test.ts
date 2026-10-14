import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { PrivateAgentGrantStore } from "../src/auth/privateAgentGrants.js";
import type { StoredSession } from "../src/auth/cookieSession.js";

const now = 2000;
const owner = { sessionId: "invented-session", householdId: "invented-family", userId: "invented-adult",
  sessionTokenSha256: "a".repeat(64), expiresAt: now + 7200 };
const active: StoredSession = { ...owner, userStatus: "active", sessionAuthVersion: 1,
  userAuthVersion: 1, revokedAt: null, csrfSecret: Buffer.alloc(32, 3) };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adeno-fictional-agent-grants-"));
  return { root, store: new PrivateAgentGrantStore(root) };
}

it("creates a short-lived server-held binding containing no plaintext credential", async () => {
  const { root, store } = await fixture();
  const grant = await store.issue(owner, now);
  expect(grant.expiresAt).toBe(now + 3600);
  const wire = await readFile(join(root, `${grant.grantId}.json`), "utf8");
  expect(wire).not.toContain("sessionToken\"");
  expect(wire).not.toContain("csrfSecret");
  expect(await store.authorize(grant.grantId, { findByTokenSha256: async hash => {
    expect(hash).toBe(owner.sessionTokenSha256); return active;
  } }, now)).toEqual({ userId: owner.userId, householdId: owner.householdId });
});

it("rechecks session revocation, expiry and identity for each grant use", async () => {
  const { store } = await fixture(); const grant = await store.issue(owner, now);
  let session: StoredSession = active;
  const sessions = { findByTokenSha256: async () => session };
  expect(await store.authorize(grant.grantId, sessions, now)).not.toBeNull();
  for (const change of [{ revokedAt: now }, { userAuthVersion: 2 },
    { householdId: "other-family" }, { sessionId: "another-session" }]) {
    session = { ...active, ...change };
    expect(await store.authorize(grant.grantId, sessions, now)).toBeNull();
  }
  session = active;
  expect(await store.authorize(grant.grantId, sessions, now + 3600)).toBeNull();
});

it("lets only the same verified account revoke a connection without deleting metadata", async () => {
  const { root, store } = await fixture(); const grant = await store.issue(owner, now);
  expect(await store.revoke(grant.grantId, { ...owner, userId: "other-adult" })).toBe(false);
  expect(await store.revoke(grant.grantId, owner)).toBe(true);
  expect(await store.revoke(grant.grantId, owner)).toBe(true);
  expect(await readFile(join(root, `${grant.grantId}.json`), "utf8")).toContain("hermes-stdio");
  expect(await store.authorize(grant.grantId, { findByTokenSha256: async () => active }, now)).toBeNull();
});

it("rejects path traversal, unsafe permissions, symlinks and mismatched grant IDs", async () => {
  const { root, store } = await fixture(); const grant = await store.issue(owner, now);
  const sessions = { findByTokenSha256: async () => active };
  expect(await store.authorize("../private-file", sessions, now)).toBeNull();
  await chmod(join(root, `${grant.grantId}.json`), 0o644);
  expect(await store.authorize(grant.grantId, sessions, now)).toBeNull();
  const alias = "b".repeat(32);
  await symlink(join(root, `${grant.grantId}.json`), join(root, `${alias}.json`));
  expect(await store.authorize(alias, sessions, now)).toBeNull();
  await writeFile(join(root, `${"c".repeat(32)}.json`), JSON.stringify({
    ...owner, version: 1, id: grant.grantId, issuedAt: now, expiresAt: now + 30, audience: "hermes-stdio",
  }), { mode: 0o600 });
  expect(await store.authorize("c".repeat(32), sessions, now)).toBeNull();
});

it("serializes grant issuance so concurrent requests cannot bypass the file cap", async () => {
  const { store } = await fixture();
  const first = store.issue(owner, now);
  await expect(store.issue(owner, now)).rejects.toThrow("busy");
  expect((await first).grantId).toMatch(/^[0-9a-f]{32}$/);
  expect((await store.issue(owner, now)).grantId).toMatch(/^[0-9a-f]{32}$/);
});

it("caps a connection at session expiry and rejects expired approval without wedging issuance", async () => {
  const { store } = await fixture();
  await expect(store.issue({ ...owner, expiresAt: now }, now)).rejects.toThrow();
  const grant = await store.issue({ ...owner, expiresAt: now + 30 }, now);
  expect(grant.expiresAt).toBe(now + 30);
  const sessions = { findByTokenSha256: async () => active };
  expect(await store.authorize(grant.grantId, sessions, now - 1)).toBeNull();
  expect(await store.authorize(grant.grantId, sessions, now + 29)).not.toBeNull();
  expect(await store.authorize(grant.grantId, sessions, now + 30)).toBeNull();
});
