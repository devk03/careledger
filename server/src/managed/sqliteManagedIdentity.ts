import { randomBytes } from "node:crypto";
import { domainToASCII } from "node:url";

import { Algorithm, hash, verify } from "@node-rs/argon2";
import Database from "better-sqlite3";

import { issueCsrfToken, issueSessionToken, verifyCsrfToken,
  type MutationPreflight } from
  "../auth/cookieSession.js";
import { assertManagedSchema } from "./managedSchemaGuard.js";

const ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SESSION_TTL = 8 * 60 * 60;
const PASSWORD_OPTIONS = { algorithm: Algorithm.Argon2id,
  memoryCost: 65_536, timeCost: 3, parallelism: 4, outputLen: 32 } as const;
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=4$xGJjFeHR72TWq4NcTFi3OQ$bqdxEI06lCP2j7o2AqXq8ceCYo1SUnQXd7+pTOysm3w";

type LoginAccountRow = { id: string; passwordHash: string };
type ActiveIdentityRow = { householdId: string; accountId: string;
  passwordHash: string; accountVersion: number; membershipVersion: number;
  role: "owner" | "adult" | "child"; memberKind: "adult" | "child" };
type SessionRow = { householdId: string; accountId: string;
  sessionId: string; csrfSecret: Buffer; expiresAt: number;
  role: "owner" | "adult" | "child"; memberKind: "adult" | "child" };

export class ManagedIdentityDenied extends Error {
  constructor() {
    super("This account operation could not be completed.");
    this.name = "ManagedIdentityDenied";
  }
}

export type ManagedIssuedLogin = { householdId: string; accountId: string;
  sessionId: string; sessionToken: string; csrfToken: string;
  expiresAt: number; role: "owner" | "adult" | "child";
  memberKind: "adult" | "child" };
export type ManagedSessionView = Omit<ManagedIssuedLogin, "sessionToken">;

/**
 * UNMOUNTED managed-v10 identity candidate. Signup creates only pending rows;
 * it cannot send or verify email, activate accounts, approve a device, or
 * recover keys. Public routes need a durable distributed limiter, email
 * verification, and a separate reauthenticated owner-device ceremony.
 */
export class SqliteManagedIdentityCandidate {
  private activePasswordOperations = 0;

  constructor(private readonly db: Database.Database) {
    assertManagedSchema(db);
  }

  /** Always returns the same acknowledgment; never issues a login cookie. */
  async registerPendingOwner(input: { email: string; password: string }):
    Promise<{ accepted: true }> {
    try {
      const email = normalizeEmail(input.email);
      if (!validPassword(input.password)) throw new ManagedIdentityDenied();
      // Hash on both existing and new-email paths to reduce enumeration timing.
      const passwordHash = await this.passwordOperation(() =>
        hash(input.password, PASSWORD_OPTIONS));
      const register = this.db.transaction(() => {
        assertManagedSchema(this.db);
        if (this.db.prepare("SELECT 1 FROM managed_accounts " +
          "WHERE login_email=?").get(email)) return;
        const now = databaseNow(this.db);
        const householdId = randomBytes(16).toString("hex");
        const accountId = randomBytes(16).toString("hex");
        this.db.prepare("INSERT INTO managed_families " +
          "(id,state,created_at) VALUES (?,'frozen',?)")
          .run(householdId, now);
        this.db.prepare("INSERT INTO managed_accounts " +
          "(id,login_email,password_hash,state,created_at) " +
          "VALUES (?,?,?,'pending',?)")
          .run(accountId, email, passwordHash, now);
        this.db.prepare("INSERT INTO managed_memberships " +
          "(household_id,account_id,member_kind,role,state,created_at) " +
          "VALUES (?,?,'adult','owner','pending',?)")
          .run(householdId, accountId, now);
      });
      register.immediate();
      return { accepted: true };
    } catch { throw new ManagedIdentityDenied(); }
  }

  /** Login requires a separately verified and activated account/membership. */
  async login(input: { email: string; password: string;
    householdId: string }): Promise<ManagedIssuedLogin> {
    try {
      const email = normalizeEmail(input.email);
      if (!validPassword(input.password) || !ID.test(input.householdId))
        throw new ManagedIdentityDenied();
      assertManagedSchema(this.db);
      const preliminary = this.db.prepare<[string], LoginAccountRow>(
        "SELECT id, password_hash AS passwordHash " +
        "FROM managed_accounts WHERE login_email=?",
      ).get(email);
      let matches = false;
      try { matches = await this.passwordOperation(() =>
        verify(preliminary?.passwordHash ?? DUMMY_PASSWORD_HASH,
          input.password)); }
      catch { /* Generic denial; do not reveal account state. */ }
      if (!matches || !preliminary) throw new ManagedIdentityDenied();
      const issue = this.db.transaction((): ManagedIssuedLogin => {
        assertManagedSchema(this.db);
        const row = this.activeIdentity(email, input.householdId);
        if (!row || row.accountId !== preliminary.id ||
          row.passwordHash !== preliminary.passwordHash)
          throw new ManagedIdentityDenied();
        const now = databaseNow(this.db);
        const sessionId = randomBytes(16).toString("hex");
        const token = issueSessionToken();
        const csrfSecret = randomBytes(32);
        const expiresAt = now + SESSION_TTL;
        this.db.prepare("INSERT INTO managed_sessions " +
          "(household_id,id,account_id,token_sha256,csrf_secret," +
          "account_auth_version,membership_auth_version,created_at,expires_at) " +
          "VALUES (?,?,?,?,?,?,?,?,?)").run(row.householdId, sessionId,
          row.accountId, Buffer.from(token.sha256, "hex"), csrfSecret,
          row.accountVersion, row.membershipVersion, now, expiresAt);
        const result: ManagedIssuedLogin = {
          householdId: row.householdId, accountId: row.accountId,
          sessionId, sessionToken: token.plaintext,
          csrfToken: issueCsrfToken(sessionId, csrfSecret), expiresAt,
          role: row.role, memberKind: row.memberKind,
        };
        // A future route must set an HttpOnly cookie, never JSON-serialize it.
        Object.defineProperty(result, "sessionToken", { enumerable: false });
        return result;
      });
      return issue.immediate();
    } catch { throw new ManagedIdentityDenied(); }
  }

  /** Cookie-derived digest only. Recheck both auth versions on every read. */
  readSession(tokenSha256: string): ManagedSessionView | null {
    try {
      if (typeof tokenSha256 !== "string" || !SHA256.test(tokenSha256))
        return null;
      const read = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const row = this.loadLiveSession(Buffer.from(tokenSha256, "hex"));
        if (!row) return null;
        return { householdId: row.householdId, accountId: row.accountId,
          sessionId: row.sessionId, expiresAt: row.expiresAt,
          role: row.role, memberKind: row.memberKind,
          csrfToken: issueCsrfToken(row.sessionId, row.csrfSecret) };
      });
      return read.deferred();
    } catch { return null; }
  }

  /** Caller must first enforce configured Origin/Fetch Metadata via the shared
   * cookie preflight. Recheck current authority and CSRF in the transaction. */
  logout(input: Extract<MutationPreflight, { ok: true }>): void {
    try {
      if (!input || input.ok !== true ||
        typeof input.tokenSha256 !== "string" ||
        !SHA256.test(input.tokenSha256) ||
        typeof input.csrfToken !== "string" || input.csrfToken.length > 256)
        throw new ManagedIdentityDenied();
      const revoke = this.db.transaction(() => {
        assertManagedSchema(this.db);
        const row = this.loadLiveSession(Buffer.from(input.tokenSha256, "hex"));
        if (!row || !verifyCsrfToken(input.csrfToken, row.sessionId,
          row.csrfSecret)) throw new ManagedIdentityDenied();
        const changed = this.db.prepare("UPDATE managed_sessions " +
          "SET revoked_at=unixepoch('now') " +
          "WHERE household_id=? AND id=? AND revoked_at IS NULL " +
          "AND expires_at>unixepoch('now')")
          .run(row.householdId, row.sessionId);
        if (changed.changes !== 1) throw new ManagedIdentityDenied();
      });
      revoke.immediate();
    } catch { throw new ManagedIdentityDenied(); }
  }

  private activeIdentity(email: string, householdId: string):
    ActiveIdentityRow | undefined {
    return this.db.prepare<[string, string], ActiveIdentityRow>(
      "SELECT f.id AS householdId, a.id AS accountId, " +
      "a.password_hash AS passwordHash, a.auth_version AS accountVersion, " +
      "m.auth_version AS membershipVersion, m.role, m.member_kind AS memberKind " +
      "FROM managed_accounts a " +
      "JOIN managed_memberships m ON m.account_id=a.id " +
      "JOIN managed_families f ON f.id=m.household_id " +
      "WHERE a.login_email=? AND f.id=? AND a.state='active' " +
      "AND a.email_verified_at IS NOT NULL AND m.state='active' " +
      "AND f.state='active'",
    ).get(email, householdId);
  }

  private loadLiveSession(token: Buffer): SessionRow | undefined {
    return this.db.prepare<[Buffer], SessionRow>(
      "SELECT s.household_id AS householdId, s.account_id AS accountId, " +
      "s.id AS sessionId, s.csrf_secret AS csrfSecret, " +
      "s.expires_at AS expiresAt, m.role, m.member_kind AS memberKind " +
      "FROM managed_sessions s " +
      "JOIN managed_accounts a ON a.id=s.account_id " +
      "JOIN managed_memberships m ON m.household_id=s.household_id " +
      "AND m.account_id=s.account_id " +
      "JOIN managed_families f ON f.id=s.household_id " +
      "WHERE s.token_sha256=? AND s.revoked_at IS NULL " +
      "AND s.expires_at>unixepoch('now') " +
      "AND s.account_auth_version=a.auth_version " +
      "AND s.membership_auth_version=m.auth_version " +
      "AND a.state='active' AND a.email_verified_at IS NOT NULL " +
      "AND m.state='active' AND f.state='active'",
    ).get(token);
  }

  /** Process-local Argon2 memory backstop, not a deployed abuse limiter. */
  private async passwordOperation<T>(work: () => Promise<T>): Promise<T> {
    if (this.activePasswordOperations >= 4) throw new ManagedIdentityDenied();
    this.activePasswordOperations += 1;
    try { return await work(); }
    finally { this.activePasswordOperations -= 1; }
  }
}

function normalizeEmail(value: string): string {
  if (typeof value !== "string" || value.length > 254) throw new ManagedIdentityDenied();
  const email = value.trim().normalize("NFC");
  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) throw new ManagedIdentityDenied();
  const local = email.slice(0, at).toLowerCase();
  const domain = domainToASCII(email.slice(at + 1)).toLowerCase();
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local) ||
    local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
    domain.length < 3 || !domain.includes(".") ||
    domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
    throw new ManagedIdentityDenied();
  const normalized = `${local}@${domain}`;
  if (normalized.length > 254) throw new ManagedIdentityDenied();
  return normalized;
}

function validPassword(value: string): boolean {
  return typeof value === "string" && value.length >= 12 &&
    value.length <= 128 && !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= 512;
}

function databaseNow(db: Database.Database): number {
  const now = db.prepare<[], { now: number }>(
    "SELECT unixepoch('now') AS now").get()?.now;
  if (!Number.isSafeInteger(now) || now! < 1) throw new ManagedIdentityDenied();
  return now!;
}
