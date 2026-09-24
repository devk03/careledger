import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Algorithm, hash, verify } from "@node-rs/argon2";
import Database from "better-sqlite3";

import { issueCsrfToken, issueSessionToken, type MutationPreflight,
  type StoredSession, verifyStoredMutationSession } from "./cookieSession.js";
import { BootstrapTokenStore } from "./bootstrapTokenStore.js";
import { generateRecoveryCodes, verifyRecoveryCode } from "./recoveryCodes.js";
import { IncompatibleFamilyTimelineDatabase, privateFile, verifySchema } from "../storage/sqliteFamilyTimeline.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const LOGIN_PATTERN = /^[a-zA-Z0-9._-]{3,40}$/;
const PASSWORD_OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 65_536,
  timeCost: 3, parallelism: 4, outputLen: 32 } as const;
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$xGJjFeHR72TWq4NcTFi3OQ$bqdxEI06lCP2j7o2AqXq8ceCYo1SUnQXd7+pTOysm3w";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const INVITATION_TTL_SECONDS = 24 * 60 * 60;

type SessionRow = {
  sessionId: string; householdId: string; userId: string;
  userStatus: StoredSession["userStatus"]; sessionAuthVersion: number;
  userAuthVersion: number; expiresAt: number; revokedAt: number | null; csrfSecret: Buffer;
};
type UserRow = { id: string; householdId: string; displayName: string;
  role: "owner" | "caregiver"; memberKind: "adult" | "child";
  status: "active" | "pending" | "disabled"; passwordHash: string | null; authVersion: number };
type InvitationRow = { id: string; householdId: string; memberKind: "adult" | "child";
  expiresAt: number; acceptedAt: number | null };
type AuditRow = { event_hash: string };
type RecoveryRow = { id: string; codeHash: string; batchId: string;
  userId: string; householdId: string; displayName: string; authVersion: number };

export type AccountError = "INVALID_INPUT" | "INVALID_CREDENTIALS" | "TRY_LATER" |
  "INVITATION_INVALID" | "LOGIN_TAKEN" | "AUTH_REQUIRED" | "INVALID_CSRF" |
  "FORBIDDEN" | "SETUP_COMPLETE" | "INVALID_SETUP";
export type AccountResult<T> = { ok: true; value: T } | { ok: false; error: AccountError };
export type IssuedLogin = { userId: string; displayName: string; role: "owner" | "caregiver";
  memberKind: "adult" | "child"; sessionToken: string; csrfToken: string; expiresAt: number };

/** Separate accounts on a pre-migrated, trusted-local v7 database only. */
export class SqliteFamilyAccounts {
  private readonly db: Database.Database;
  private readonly loginAttempts = new Map<string, { failures: number; lockedUntil: number; lastSeen: number }>();
  private activeVerifications = 0;

  constructor(path: string) {
    privateFile(path, true);
    privateFile(`${path}-wal`, false);
    privateFile(`${path}-shm`, false);
    let db: Database.Database;
    try {
      db = new Database(path, { fileMustExist: true, timeout: 5_000 });
      db.pragma("foreign_keys = ON");
      db.pragma("trusted_schema = ON");
      verifySchema(db);
    } catch {
      if (db!) db.close();
      throw new IncompatibleFamilyTimelineDatabase();
    }
    this.db = db;
  }

  close(): void { this.db.close(); }

  isSetupComplete(): boolean {
    return this.db.prepare<[], { setupCompletedAt: number | null }>(
      "SELECT setup_completed_at setupCompletedAt FROM app_state WHERE singleton = 1",
    ).get()?.setupCompletedAt !== null;
  }

  async setupOwner(input: { token: string; displayName: string; householdName: string;
    password: string; bootstrap: BootstrapTokenStore; recoveryPepper: Uint8Array;
    nowSeconds?: number }): Promise<AccountResult<IssuedLogin & { recoveryCodes: string[] }>> {
    const nowSeconds = input.nowSeconds ?? now();
    if (input.displayName.trim().length < 1 || input.displayName.length > 120 ||
      input.householdName.trim().length < 1 || input.householdName.length > 120 ||
      !validPassword(input.password) || input.recoveryPepper.byteLength < 32)
      return { ok: false, error: "INVALID_INPUT" };
    if (this.db.prepare<[], { setupCompletedAt: number | null }>(
      "SELECT setup_completed_at setupCompletedAt FROM app_state WHERE singleton = 1",
    ).get()?.setupCompletedAt !== null) return { ok: false, error: "SETUP_COMPLETE" };
    if (!input.bootstrap.verify(input.token, nowSeconds)) return { ok: false, error: "INVALID_SETUP" };
    const passwordHash = await hash(input.password, PASSWORD_OPTIONS);
    const codes = generateRecoveryCodes(input.recoveryPepper);
    const result = this.db.transaction((): AccountResult<IssuedLogin & { recoveryCodes: string[] }> => {
      const state = this.db.prepare<[], { setupCompletedAt: number | null }>(
        "SELECT setup_completed_at setupCompletedAt FROM app_state WHERE singleton = 1",
      ).get();
      if (!state || state.setupCompletedAt !== null || this.db.prepare(
        "SELECT 1 FROM users WHERE role = 'owner' AND status = 'active'",
      ).get()) return { ok: false, error: "SETUP_COMPLETE" };
      if (!input.bootstrap.verify(input.token, nowSeconds)) return { ok: false, error: "INVALID_SETUP" };
      const householdId = randomUUID();
      const userId = randomUUID();
      this.db.prepare("INSERT INTO households (singleton, id, display_name, created_at) " +
        "VALUES (1, ?, ?, ?)").run(householdId, input.householdName.trim(), nowSeconds);
      this.db.prepare("INSERT INTO users (id, household_id, login_name, login_name_normalized, " +
        "display_name, role, status, password_hash, created_at, updated_at, password_changed_at, " +
        "member_kind) VALUES (?, ?, 'owner', 'owner', ?, 'owner', 'active', ?, ?, ?, ?, 'adult')")
        .run(userId, householdId, input.displayName.trim(), passwordHash,
          nowSeconds, nowSeconds, nowSeconds);
      const batchId = randomUUID();
      const insertCode = this.db.prepare("INSERT INTO recovery_codes (id, user_id, batch_id, " +
        "code_hmac, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const codeHash of codes.hashes)
        insertCode.run(randomUUID(), userId, batchId, codeHash, nowSeconds);
      const issued = this.insertSession(userId, 1, nowSeconds);
      this.db.prepare("UPDATE app_state SET setup_completed_at = ?, active_household_id = ? " +
        "WHERE singleton = 1 AND setup_completed_at IS NULL").run(nowSeconds, householdId);
      this.audit(householdId, userId, "owner_setup", "user", userId, nowSeconds);
      return { ok: true, value: { userId, displayName: input.displayName.trim(),
        role: "owner", memberKind: "adult", ...issued, recoveryCodes: codes.plaintext } };
    }).immediate();
    if (result.ok) {
      try { input.bootstrap.complete(); }
      catch { /* The committed DB state still prevents a second setup. */ }
    }
    return result;
  }

  async recoverOwner(input: { code: string; newPassword: string;
    recoveryPepper: Uint8Array; nowSeconds?: number }):
    Promise<AccountResult<IssuedLogin & { recoveryCodes: string[] }>> {
    const nowSeconds = input.nowSeconds ?? now();
    if (!validPassword(input.newPassword) || input.recoveryPepper.byteLength < 32 ||
      !/^[A-Za-z2-7]{4}(?:-[A-Za-z2-7]{4}){3}$/.test(input.code))
      return { ok: false, error: "INVALID_INPUT" };
    const rows = this.db.prepare<[], RecoveryRow>(
      "SELECT rc.id, rc.code_hmac codeHash, rc.batch_id batchId, u.id userId, " +
      "u.household_id householdId, u.display_name displayName, u.auth_version authVersion " +
      "FROM recovery_codes rc JOIN users u ON u.id = rc.user_id " +
      "WHERE rc.used_at IS NULL AND rc.revoked_at IS NULL " +
      "AND u.role = 'owner' AND u.status = 'active'",
    ).all();
    const matched = rows.find((row) => verifyRecoveryCode(
      input.code, row.codeHash, input.recoveryPepper));
    if (!matched) return { ok: false, error: "INVALID_CREDENTIALS" };
    const passwordHash = await hash(input.newPassword, PASSWORD_OPTIONS);
    const replacements = generateRecoveryCodes(input.recoveryPepper);
    return this.db.transaction((): AccountResult<IssuedLogin & { recoveryCodes: string[] }> => {
      const current = this.db.prepare<[string, string], { authVersion: number }>(
        "SELECT u.auth_version authVersion FROM recovery_codes rc " +
        "JOIN users u ON u.id = rc.user_id WHERE rc.id = ? AND u.id = ? " +
        "AND rc.used_at IS NULL AND rc.revoked_at IS NULL AND u.status = 'active'",
      ).get(matched.id, matched.userId);
      if (!current || current.authVersion !== matched.authVersion)
        return { ok: false, error: "INVALID_CREDENTIALS" };
      this.db.prepare("UPDATE recovery_codes SET used_at = ? WHERE id = ?")
        .run(nowSeconds, matched.id);
      this.db.prepare("UPDATE recovery_codes SET revoked_at = ? WHERE user_id = ? " +
        "AND batch_id = ? AND revoked_at IS NULL").run(nowSeconds, matched.userId, matched.batchId);
      this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(nowSeconds, matched.userId);
      const newVersion = matched.authVersion + 1;
      this.db.prepare("UPDATE users SET password_hash = ?, auth_version = ?, updated_at = ?, " +
        "password_changed_at = ? WHERE id = ? AND status = 'active'")
        .run(passwordHash, newVersion, nowSeconds, nowSeconds, matched.userId);
      const batchId = randomUUID();
      const insertCode = this.db.prepare("INSERT INTO recovery_codes (id, user_id, batch_id, " +
        "code_hmac, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const codeHash of replacements.hashes)
        insertCode.run(randomUUID(), matched.userId, batchId, codeHash, nowSeconds);
      const issued = this.insertSession(matched.userId, newVersion, nowSeconds);
      this.audit(matched.householdId, matched.userId,
        "owner_recovery", "user", matched.userId, nowSeconds);
      return { ok: true, value: { userId: matched.userId,
        displayName: matched.displayName, role: "owner", memberKind: "adult",
        ...issued, recoveryCodes: replacements.plaintext } };
    }).immediate();
  }

  issueInvitation(preflight: Extract<MutationPreflight, { ok: true }>,
    memberKind: "adult" | "child", nowSeconds = now()): AccountResult<{ token: string; expiresAt: number }> {
    return this.db.transaction(() => {
      const decision = this.authorizeMutation(preflight, nowSeconds);
      if (!decision.ok) return decision;
      const actor = this.userById(decision.value.userId);
      if (actor?.role !== "owner" || actor.memberKind !== "adult")
        return { ok: false as const, error: "FORBIDDEN" as const };
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      const expiresAt = nowSeconds + INVITATION_TTL_SECONDS;
      this.db.prepare("INSERT INTO invitations (id, household_id, token_sha256, role, " +
        "created_by, created_at, expires_at, member_kind) " +
        "VALUES (?, ?, ?, 'caregiver', ?, ?, ?, ?)")
        .run(id, decision.value.householdId, createHash("sha256").update(token).digest("hex"),
          actor.id, nowSeconds, expiresAt, memberKind);
      this.audit(decision.value.householdId, actor.id, "invitation_issued", "invitation", id, nowSeconds);
      return { ok: true as const, value: { token, expiresAt } };
    }).immediate();
  }

  async acceptInvitation(input: { token: string; loginName: string; displayName: string;
    password: string; nowSeconds?: number }): Promise<AccountResult<IssuedLogin>> {
    const nowSeconds = input.nowSeconds ?? now();
    if (!TOKEN_PATTERN.test(input.token) || !LOGIN_PATTERN.test(input.loginName) ||
      input.displayName.trim().length < 1 || input.displayName.length > 120 ||
      !validPassword(input.password)) return { ok: false, error: "INVALID_INPUT" };
    // Reject random/expired bearer tokens before an expensive Argon2 hash.
    const tokenSha256 = createHash("sha256").update(input.token).digest("hex");
    const preliminary = this.db.prepare<[string], InvitationRow>(
      "SELECT id, household_id householdId, member_kind memberKind, " +
      "expires_at expiresAt, accepted_at acceptedAt FROM invitations WHERE token_sha256 = ?",
    ).get(tokenSha256);
    if (!preliminary || preliminary.acceptedAt !== null || preliminary.expiresAt <= nowSeconds)
      return { ok: false, error: "INVITATION_INVALID" };
    const passwordHash = await hash(input.password, PASSWORD_OPTIONS);
    return this.db.transaction((): AccountResult<IssuedLogin> => {
      const invitation = this.db.prepare<[string], InvitationRow>(
        "SELECT id, household_id householdId, member_kind memberKind, " +
        "expires_at expiresAt, accepted_at acceptedAt FROM invitations WHERE token_sha256 = ?",
      ).get(tokenSha256);
      if (!invitation || invitation.acceptedAt !== null || invitation.expiresAt <= nowSeconds)
        return { ok: false, error: "INVITATION_INVALID" };
      const normalized = input.loginName.toLowerCase();
      const taken = this.db.prepare<[string, string]>(
        "SELECT 1 FROM users WHERE household_id = ? AND login_name_normalized = ?",
      ).get(invitation.householdId, normalized);
      if (taken) return { ok: false, error: "LOGIN_TAKEN" };
      const userId = randomUUID();
      const displayName = input.displayName.trim();
      this.db.prepare("INSERT INTO users (id, household_id, login_name, login_name_normalized, " +
        "display_name, role, status, password_hash, created_at, updated_at, password_changed_at, member_kind) " +
        "VALUES (?, ?, ?, ?, ?, 'caregiver', 'active', ?, ?, ?, ?, ?)")
        .run(userId, invitation.householdId, input.loginName, normalized, displayName,
          passwordHash, nowSeconds, nowSeconds, nowSeconds, invitation.memberKind);
      this.db.prepare("UPDATE invitations SET accepted_by = ?, accepted_at = ? " +
        "WHERE id = ? AND accepted_at IS NULL").run(userId, nowSeconds, invitation.id);
      const issued = this.insertSession(userId, 1, nowSeconds);
      this.audit(invitation.householdId, userId, "invitation_accepted", "invitation", invitation.id, nowSeconds);
      return { ok: true, value: { userId, displayName, role: "caregiver",
        memberKind: invitation.memberKind, ...issued } };
    }).immediate();
  }

  async login(input: { loginName: string; password: string; nowSeconds?: number }):
    Promise<AccountResult<IssuedLogin>> {
    const nowSeconds = input.nowSeconds ?? now();
    if (!LOGIN_PATTERN.test(input.loginName) || !validPassword(input.password))
      return { ok: false, error: "INVALID_INPUT" };
    const normalized = input.loginName.toLowerCase();
    const throttle = this.loginAttempts.get(normalized);
    if ((throttle && throttle.lockedUntil > nowSeconds) || this.activeVerifications >= 4)
      return { ok: false, error: "TRY_LATER" };
    const user = this.db.prepare<[string], UserRow>(
      "SELECT id, household_id householdId, display_name displayName, role, member_kind memberKind, " +
      "status, password_hash passwordHash, auth_version authVersion FROM users " +
      "WHERE login_name_normalized = ? AND status = 'active'",
    ).get(normalized);
    let passwordMatches = false;
    this.activeVerifications += 1;
    try {
      passwordMatches = await verify(user?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);
    } catch { passwordMatches = false; }
    finally { this.activeVerifications -= 1; }
    return this.db.transaction((): AccountResult<IssuedLogin> => {
      const currentThrottle = this.loginAttempts.get(normalized);
      if (currentThrottle && currentThrottle.lockedUntil > nowSeconds)
        return { ok: false, error: "TRY_LATER" };
      const current = user ? this.userById(user.id) : null;
      if (!passwordMatches || !current || current.status !== "active" ||
        current.passwordHash !== user?.passwordHash) {
        const failures = (currentThrottle?.failures ?? 0) + 1;
        const delay = failures <= 4 ? 0 : Math.min(2 ** (failures - 5) * 2, 900);
        this.pruneLoginAttempts(nowSeconds);
        this.loginAttempts.set(normalized,
          { failures, lockedUntil: nowSeconds + delay, lastSeen: nowSeconds });
        return { ok: false, error: delay ? "TRY_LATER" : "INVALID_CREDENTIALS" };
      }
      this.loginAttempts.delete(normalized);
      const issued = this.insertSession(current.id, current.authVersion, nowSeconds);
      this.audit(current.householdId, current.id, "login", "session", issued.sessionId, nowSeconds);
      return { ok: true, value: { userId: current.id, displayName: current.displayName,
        role: current.role, memberKind: current.memberKind, ...issued } };
    }).immediate();
  }

  private pruneLoginAttempts(nowSeconds: number): void {
    for (const [key, entry] of this.loginAttempts) {
      if (entry.lastSeen + 3600 < nowSeconds) this.loginAttempts.delete(key);
    }
    if (this.loginAttempts.size >= 10_000) {
      const oldest = this.loginAttempts.keys().next().value;
      if (oldest) this.loginAttempts.delete(oldest);
    }
  }

  logout(preflight: Extract<MutationPreflight, { ok: true }>, nowSeconds = now()): AccountResult<null> {
    return this.db.transaction((): AccountResult<null> => {
      const decision = this.authorizeMutation(preflight, nowSeconds);
      if (!decision.ok) return decision;
      this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(nowSeconds, decision.value.sessionId);
      this.audit(decision.value.householdId, decision.value.userId,
        "logout", "session", decision.value.sessionId, nowSeconds);
      return { ok: true, value: null };
    }).immediate();
  }

  private authorizeMutation(preflight: Extract<MutationPreflight, { ok: true }>, nowSeconds: number):
    AccountResult<{ userId: string; householdId: string; sessionId: string }> {
    const row = this.db.prepare<[string], SessionRow>(
      "SELECT s.id sessionId, u.household_id householdId, u.id userId, u.status userStatus, " +
      "s.auth_version sessionAuthVersion, u.auth_version userAuthVersion, " +
      "s.expires_at expiresAt, s.revoked_at revokedAt, s.csrf_secret csrfSecret " +
      "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_sha256 = ?",
    ).get(preflight.tokenSha256);
    const decision = verifyStoredMutationSession(row ?? null, preflight.csrfToken, nowSeconds);
    if (!decision.ok) return { ok: false, error: decision.error };
    return { ok: true, value: { userId: decision.session.scope.userId,
      householdId: decision.session.scope.householdId, sessionId: decision.session.sessionId } };
  }

  private userById(id: string): UserRow | null {
    return this.db.prepare<[string], UserRow>(
      "SELECT id, household_id householdId, display_name displayName, role, member_kind memberKind, " +
      "status, password_hash passwordHash, auth_version authVersion FROM users WHERE id = ?",
    ).get(id) ?? null;
  }

  private insertSession(userId: string, authVersion: number, nowSeconds: number):
    { sessionId: string; sessionToken: string; csrfToken: string; expiresAt: number } {
    const sessionId = randomUUID();
    const issued = issueSessionToken();
    const secret = randomBytes(32);
    const expiresAt = nowSeconds + SESSION_TTL_SECONDS;
    this.db.prepare("INSERT INTO sessions (id, user_id, token_sha256, csrf_secret, auth_version, " +
      "created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sessionId, userId, issued.sha256, secret, authVersion, nowSeconds, expiresAt, nowSeconds);
    return { sessionId, sessionToken: issued.plaintext,
      csrfToken: issueCsrfToken(sessionId, secret), expiresAt };
  }

  private audit(householdId: string, actorUserId: string, action: string,
    entityKind: string, entityId: string, occurredAt: number): void {
    const previousHash = this.db.prepare<[], AuditRow>(
      "SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1",
    ).get()?.event_hash ?? null;
    const id = randomUUID();
    const canonical = JSON.stringify({ action, actor_user_id: actorUserId,
      entity_id: entityId, entity_kind: entityKind, household_id: householdId,
      id, occurred_at: occurredAt, outcome: "success", previous_hash: previousHash });
    const eventHash = createHash("sha256").update(canonical).digest("hex");
    this.db.prepare("INSERT INTO audit_events (id, household_id, actor_user_id, action, " +
      "entity_kind, entity_id, outcome, occurred_at, previous_hash, event_hash) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?)")
      .run(id, householdId, actorUserId, action, entityKind, entityId,
        occurredAt, previousHash, eventHash);
  }
}

function validPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 128 && !password.includes("\0");
}

function now(): number { return Math.floor(Date.now() / 1000); }
