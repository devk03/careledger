import { randomBytes } from "node:crypto";
import { constants, lstatSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod/v4";
import { readSessionByDigest, type SessionRepository } from "./cookieSession.js";
import type { AuthorizedScope } from "../timeline/types.js";

const grantIdPattern = /^[0-9a-f]{32}$/;
const opaqueId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const schema = z.object({ version: z.literal(1), id: z.string().regex(grantIdPattern),
  sessionId: opaqueId, userId: opaqueId, householdId: opaqueId,
  sessionTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  audience: z.literal("hermes-stdio"),
}).strict().refine(record => record.expiresAt > record.issuedAt && record.expiresAt - record.issuedAt <= 3600);
type Grant = z.infer<typeof schema>;
export type AgentGrantOwner = AuthorizedScope & { sessionId: string; sessionTokenSha256: string; expiresAt: number };

/** Private metadata only. Browser approval belongs to the caller, never an MCP tool. */
export class PrivateAgentGrantStore {
  private issuing = false;
  constructor(private readonly root: string) { this.checkRoot(); }

  private checkRoot() {
    if (!isAbsolute(this.root)) throw new Error("Private agent grant directory unavailable");
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) ||
      process.getuid?.() !== info.uid) throw new Error("Private agent grant directory unavailable");
  }

  private async writeOnce(name: string, bytes: string) {
    this.checkRoot();
    const handle = await open(join(this.root, name), constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async issue(owner: AgentGrantOwner, now = Math.floor(Date.now() / 1000)) {
    if (this.issuing) throw new Error("Agent connection busy");
    this.issuing = true;
    try {
      this.checkRoot();
      if (readdirSync(this.root).length >= 512) throw new Error("Agent grant capacity reached");
      const grant = schema.parse({ version: 1, id: randomBytes(16).toString("hex"),
        sessionId: owner.sessionId, userId: owner.userId, householdId: owner.householdId,
        sessionTokenSha256: owner.sessionTokenSha256, issuedAt: now,
        expiresAt: Math.min(owner.expiresAt, now + 3600), audience: "hermes-stdio" });
      await this.writeOnce(`${grant.id}.json`, JSON.stringify(grant));
      return { grantId: grant.id, expiresAt: grant.expiresAt };
    } finally { this.issuing = false; }
  }

  private async read(id: string): Promise<Grant | null> {
    if (!grantIdPattern.test(id)) return null;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      this.checkRoot();
      handle = await open(join(this.root, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size > 4096) return null;
      const bytes = Buffer.alloc(4097);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > 4096 || (await handle.stat()).size !== info.size) return null;
      const parsed = schema.safeParse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
      return parsed.success && parsed.data.id === id ? parsed.data : null;
    } catch { return null; }
    finally { await handle?.close(); }
  }

  private revoked(id: string) {
    try { lstatSync(join(this.root, `${id}.revoked`)); return true; }
    catch (error) { return !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"); }
  }

  async authorize(id: string, sessions: SessionRepository, now = Math.floor(Date.now() / 1000)):
    Promise<AuthorizedScope | null> {
    const grant = await this.read(id);
    if (!grant || grant.issuedAt > now || grant.expiresAt <= now || this.revoked(id)) return null;
    const session = await readSessionByDigest(grant.sessionTokenSha256, sessions, now);
    if (!session || session.sessionId !== grant.sessionId || session.scope.userId !== grant.userId ||
      session.scope.householdId !== grant.householdId || this.revoked(id)) return null;
    return { ...session.scope };
  }

  async revoke(id: string, owner: AuthorizedScope) {
    const grant = await this.read(id);
    if (!grant || grant.userId !== owner.userId || grant.householdId !== owner.householdId) return false;
    if (this.revoked(id)) return true;
    try { await this.writeOnce(`${id}.revoked`, "revoked\n"); return true; }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return true;
      throw new Error("Agent revocation unavailable");
    }
  }
}
