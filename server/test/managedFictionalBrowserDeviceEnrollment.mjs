import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Algorithm, hash } from "@node-rs/argon2";
import Database from "better-sqlite3";
import express from "express";

import { SESSION_COOKIE_NAME } from "../dist/auth/cookieSession.js";
import { createManagedAuthRouter } from
  "../dist/managed/managedAuthRouter.js";
import { createManagedDeviceRouter } from
  "../dist/managed/managedDeviceRouter.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { SqliteDeviceEnrollmentCandidate } from
  "../dist/managed/sqliteDeviceEnrollment.js";
import { SqliteManagedIdentityCandidate } from
  "../dist/managed/sqliteManagedIdentity.js";
import { SqliteOwnerDeviceApprovalCandidate } from
  "../dist/managed/sqliteOwnerDeviceApproval.js";
import { SqliteSessionDeviceBindingCandidate } from
  "../dist/managed/sqliteSessionDeviceBinding.js";
import { verifySessionDeviceBindingProof } from
  "../dist/managed/verifySessionDeviceBindingProof.js";

// Only the exact approved empty fictional v10 source is copied. This runner
// does not create or apply migrations, mount production routes or use records.
const EMPTY_SHA256 =
  "192af3bf39723c238659a61c3b6508be7d3ba0d88b23a6cb325d99e52a0d0df4";
const sourcePath = process.argv[2];
assert.equal(process.env.ADENO_APPROVED_FICTIONAL_MIGRATION, "1");
assert.notEqual(process.env.NODE_ENV, "production");
assert.equal(Object.keys(process.env).some(name => name.startsWith("RAILWAY_")),
  false);
assert.equal(typeof sourcePath, "string");
const sourceParent = realpathSync(dirname(sourcePath));
assert.equal(basename(sourcePath), "managed.sqlite3");
assert.match(basename(sourceParent), /^adeno-fictional-managed-[A-Za-z0-9]+$/u);
assert.equal(dirname(sourceParent), realpathSync(tmpdir()));
assert.equal(realpathSync(sourcePath), join(sourceParent, "managed.sqlite3"));
assert.equal(statSync(sourceParent).mode & 0o077, 0);
assert.equal(statSync(sourcePath).mode & 0o077, 0);
assert.equal(existsSync(`${sourcePath}-wal`), false);
assert.equal(existsSync(`${sourcePath}-shm`), false);
const sha256 = value => createHash("sha256").update(value).digest("hex");
assert.equal(sha256(readFileSync(sourcePath)), EMPTY_SHA256);

const requireWeb = createRequire(new URL("../../web/package.json",
  import.meta.url));
const { createServer: createViteServer } = requireWeb("vite");
const { chromium } = requireWeb("playwright");
const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
const copyRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-browser-device-"));
const copyPath = join(copyRoot, "managed.sqlite3");
await copyFile(sourcePath, copyPath);
await chmod(copyPath, 0o600);
const db = new Database(copyPath, { fileMustExist: true, timeout: 5_000 });
let server;
let vite;
let browser;
try {
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  assertManagedSchema(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_families").get().n,
    0);
  const now = Math.floor(Date.now() / 1000);
  const password = "fictional-owner-device-test-password";
  const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id,
    memoryCost: 65_536, timeCost: 3, parallelism: 4, outputLen: 32 });
  const id = byte => byte.repeat(32);
  const alpha = { householdId: id("1"), accountId: id("2"),
    email: "fictional-device-alpha@example.invalid" };
  const beta = { householdId: id("6"), accountId: id("7"),
    email: "fictional-device-beta@example.invalid" };
  db.transaction(() => {
    for (const family of [alpha, beta]) {
      db.prepare("INSERT INTO managed_families (id,state,created_at) " +
        "VALUES (?,'active',?)").run(family.householdId, now);
      db.prepare("INSERT INTO managed_accounts " +
        "(id,login_email,password_hash,state,email_verified_at,created_at) " +
        "VALUES (?,?,?,'active',?,?)")
        .run(family.accountId, family.email, passwordHash, now, now);
      db.prepare("INSERT INTO managed_memberships " +
        "(household_id,account_id,member_kind,role,state,created_at) " +
        "VALUES (?,?,'adult','owner','active',?)")
        .run(family.householdId, family.accountId, now);
    }
  }).immediate();

  const identity = new SqliteManagedIdentityCandidate(db);
  const app = express();
  server = await new Promise(resolve => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const rateCalls = [];
  app.use("/api/managed/auth", createManagedAuthRouter({
    expectedOrigin: base, identity,
    credentialBucketKey: randomBytes(32),
    rateLimit: input => { rateCalls.push(input); return true; },
  }));
  app.use("/api/managed/device", createManagedDeviceRouter({
    expectedOrigin: base,
    enrollment: new SqliteDeviceEnrollmentCandidate(db, base),
    approval: new SqliteOwnerDeviceApprovalCandidate(db),
    binding: new SqliteSessionDeviceBindingCandidate(db, base),
    rateLimit: input => { rateCalls.push(input); return true; },
  }));
  vite = await createViteServer({ root: webRoot,
    configFile: join(webRoot, "vite.config.ts"), mode: "ui-preview",
    server: { middlewareMode: true, hmr: false }, appType: "spa" });
  app.use(vite.middlewares);

  browser = await chromium.launch({ headless: true });
  const candidateContext = await browser.newContext();
  const candidate = await candidateContext.newPage();
  await candidate.goto(`${base}/design-system`);
  const candidateSession = await browserLogin(candidate, alpha, password);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await owner.goto(`${base}/design-system`);
  const ownerSession = await browserLogin(owner, alpha, password);
  assert.notEqual(candidateSession.sessionId, ownerSession.sessionId);
  const betaContext = await browser.newContext();
  const betaOwner = await betaContext.newPage();
  await betaOwner.goto(`${base}/design-system`);
  const betaSession = await browserLogin(betaOwner, beta, password);

  const storedCookie = (await candidateContext.cookies())
    .find(cookie => cookie.name === SESSION_COOKIE_NAME);
  assert.ok(storedCookie);
  assert.equal(storedCookie.secure, true);
  assert.equal(storedCookie.httpOnly, true);
  assert.equal(storedCookie.sameSite, "Strict");
  assert.equal(storedCookie.path, "/");
  assert.equal(await candidate.evaluate(name => document.cookie.includes(name),
    SESSION_COOKIE_NAME), false);

  const publicKeys = await candidate.evaluate(async () => {
    const { generateProposedDeviceKeys, proposedDevicePublicKeys } =
      await import("/src/crypto/deviceEnrollmentProof.ts");
    const keys = await generateProposedDeviceKeys();
    window.__fictionalDevice = { keys };
    return proposedDevicePublicKeys(keys);
  });
  const challengeRequest = { encryptionPublicKeyHex:
    publicKeys.encryptionPublicKeyHex,
    signingPublicKeyHex: publicKeys.signingPublicKeyHex };
  const deniedPreflight = await candidate.evaluate(async body => {
    const post = (credentials, csrf) => fetch(
      "/api/managed/device/enrollment-challenge", { method: "POST",
        credentials, headers: { "content-type": "application/json",
          "x-csrf-token": csrf }, body: JSON.stringify(body) });
    return { wrongCsrf: (await post("same-origin", "wrong")).status,
      missingCookie: (await post("omit", "wrong")).status };
  }, challengeRequest);
  assert.deepEqual(deniedPreflight, { wrongCsrf: 403,
    missingCookie: 401 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_enrollment_challenges").get().n, 0);

  const proposed = await candidate.evaluate(async input => {
    const { validateProposedDeviceChallengeWire,
      candidateDeviceApprovalCode, signDeviceEnrollmentChallengeWire } =
      await import("/src/crypto/deviceEnrollmentProof.ts");
    const post = async (action, body) => fetch(
      `/api/managed/device/${action}`, { method: "POST",
        credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "content-type": "application/json",
          "x-csrf-token": input.csrfToken }, body: JSON.stringify(body) });
    const challengeResponse = await post("enrollment-challenge", input.keys);
    if (challengeResponse.status !== 201)
      throw new Error("Enrollment challenge denied");
    const challenge = await challengeResponse.json();
    const state = window.__fictionalDevice;
    const expected = { householdId: input.householdId,
      accountId: input.accountId, sessionId: input.sessionId,
      origin: location.origin };
    const validated = await validateProposedDeviceChallengeWire(
      challenge, state.keys, expected);
    const comparisonCode = await candidateDeviceApprovalCode(
      challenge, state.keys, expected);
    const proof = await signDeviceEnrollmentChallengeWire(
      challenge, state.keys, expected);
    const wrong = await post("enrollment-proof", { proof: { ...proof,
      nonceHex: "00".repeat(32) } });
    const pending = await post("enrollment-proof", { proof });
    const pendingBody = await pending.json();
    const repeated = await post("enrollment-proof", { proof });
    const prematureBinding = await post("binding-challenge", {
      deviceId: validated.deviceId });
    return { challenge, comparisonCode, validatedDeviceId: validated.deviceId,
      wrongProofStatus: wrong.status, pendingStatus: pending.status,
      pendingBody, repeatedStatus: repeated.status,
      prematureBindingStatus: prematureBinding.status,
      proofIsJsonSafe: JSON.parse(JSON.stringify(proof)).challengeId ===
        challenge.challengeId };
  }, { ...candidateSession, keys: challengeRequest });
  assert.equal(proposed.challenge.householdId, alpha.householdId);
  assert.equal(proposed.challenge.accountId, alpha.accountId);
  assert.equal(proposed.challenge.sessionId, candidateSession.sessionId);
  assert.equal(proposed.validatedDeviceId, proposed.challenge.challengeId);
  assert.equal(proposed.wrongProofStatus, 403);
  assert.equal(proposed.pendingStatus, 201);
  assert.equal(proposed.repeatedStatus, 403);
  assert.deepEqual(proposed.pendingBody, { deviceId: proposed.validatedDeviceId,
    state: "pending" });
  assert.equal(proposed.prematureBindingStatus, 403);
  assert.equal(proposed.proofIsJsonSafe, true);
  assert.equal(db.prepare("SELECT state FROM managed_devices " +
    "WHERE household_id=? AND id=?")
    .get(alpha.householdId, proposed.validatedDeviceId).state, "pending");
  assert.equal(db.prepare("SELECT consumed_at IS NOT NULL AS used FROM " +
    "managed_enrollment_challenges WHERE household_id=? AND id=?")
    .get(alpha.householdId, proposed.validatedDeviceId).used, 1);

  const betaApproval = await approveInBrowser(betaOwner, betaSession,
    proposed.validatedDeviceId, proposed.comparisonCode, password);
  assert.equal(betaApproval, 403);
  const wrongCode = `${proposed.comparisonCode[0] === "0" ? "1" : "0"}` +
    proposed.comparisonCode.slice(1);
  assert.equal(await approveInBrowser(owner, ownerSession,
    proposed.validatedDeviceId, wrongCode, password), 403);
  assert.equal(db.prepare("SELECT state FROM managed_devices " +
    "WHERE household_id=? AND id=?")
    .get(alpha.householdId, proposed.validatedDeviceId).state, "pending");
  assert.equal(await approveInBrowser(owner, ownerSession,
    proposed.validatedDeviceId, proposed.comparisonCode, password), 204);
  assert.equal(db.prepare("SELECT state FROM managed_devices " +
    "WHERE household_id=? AND id=?")
    .get(alpha.householdId, proposed.validatedDeviceId).state, "active");

  const bound = await candidate.evaluate(async input => {
    const { signSessionDeviceBindingChallengeWire } = await import(
      "/src/crypto/sessionDeviceBindingProof.ts");
    const post = async (action, body) => fetch(
      `/api/managed/device/${action}`, { method: "POST",
        credentials: "same-origin", cache: "no-store", redirect: "error",
        headers: { "content-type": "application/json",
          "x-csrf-token": input.csrfToken }, body: JSON.stringify(body) });
    const challengeResponse = await post("binding-challenge", {
      deviceId: input.deviceId });
    if (challengeResponse.status !== 201)
      throw new Error("Binding challenge denied");
    const challenge = await challengeResponse.json();
    const keys = window.__fictionalDevice.keys;
    const proof = await signSessionDeviceBindingChallengeWire(
      challenge, keys.signingKeys, { householdId: input.householdId,
        accountId: input.accountId, sessionId: input.sessionId,
        deviceId: input.deviceId,
        signingPublicKeyHex: input.signingPublicKeyHex,
        origin: location.origin });
    const bad = await post("binding-proof", { proof: { ...proof,
      signatureHex: "00".repeat(64) } });
    const accepted = await post("binding-proof", { proof });
    const replay = await post("binding-proof", { proof });
    return { challenge, badStatus: bad.status,
      acceptedStatus: accepted.status, replayStatus: replay.status,
      proofIsJsonSafe: JSON.parse(JSON.stringify(proof)).challengeId ===
        challenge.challengeId };
  }, { ...candidateSession, deviceId: proposed.validatedDeviceId,
    signingPublicKeyHex: publicKeys.signingPublicKeyHex });
  assert.equal(bound.challenge.householdId, alpha.householdId);
  assert.equal(bound.challenge.accountId, alpha.accountId);
  assert.equal(bound.challenge.sessionId, candidateSession.sessionId);
  assert.equal(bound.challenge.deviceId, proposed.validatedDeviceId);
  assert.deepEqual({ bad: bound.badStatus, accepted: bound.acceptedStatus,
    replay: bound.replayStatus, json: bound.proofIsJsonSafe },
  { bad: 403, accepted: 204, replay: 403, json: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_session_device_bindings WHERE household_id=? " +
    "AND session_id=? AND device_id=?")
    .get(alpha.householdId, candidateSession.sessionId,
      proposed.validatedDeviceId).n, 1);
  assert.equal(db.prepare("SELECT consumed_at IS NOT NULL AS used FROM " +
    "managed_session_device_challenges WHERE household_id=? AND id=?")
    .get(alpha.householdId, bound.challenge.challengeId).used, 1);

  const freshContext = await browser.newContext();
  const fresh = await freshContext.newPage();
  await fresh.goto(`${base}/design-system`);
  const freshSession = await browserLogin(fresh, alpha, password);
  const inFlightChallenge = await fresh.evaluate(async input => {
    const response = await fetch("/api/managed/device/binding-challenge", {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json",
        "x-csrf-token": input.csrfToken },
      body: JSON.stringify({ deviceId: input.deviceId }),
    });
    if (response.status !== 201) throw new Error("Fresh binding denied");
    return response.json();
  }, { csrfToken: freshSession.csrfToken,
    deviceId: proposed.validatedDeviceId });
  const inFlightProof = await candidate.evaluate(async input => {
    const { signSessionDeviceBindingChallengeWire } = await import(
      "/src/crypto/sessionDeviceBindingProof.ts");
    return signSessionDeviceBindingChallengeWire(input.challenge,
      window.__fictionalDevice.keys.signingKeys, {
        householdId: input.householdId, accountId: input.accountId,
        sessionId: input.sessionId, deviceId: input.deviceId,
        signingPublicKeyHex: input.signingPublicKeyHex,
        origin: location.origin });
  }, { challenge: inFlightChallenge, ...freshSession,
    deviceId: proposed.validatedDeviceId,
    signingPublicKeyHex: publicKeys.signingPublicKeyHex });
  assert.equal(inFlightProof.challengeId, inFlightChallenge.challengeId);
  assert.equal(inFlightProof.nonceHex, inFlightChallenge.nonceHex);
  verifySessionDeviceBindingProof({ context: {
    householdId: inFlightChallenge.householdId,
    accountId: inFlightChallenge.accountId,
    sessionId: inFlightChallenge.sessionId,
    deviceId: inFlightChallenge.deviceId,
    challengeId: inFlightChallenge.challengeId,
    nonceSha256: sha256(Buffer.from(inFlightChallenge.nonceHex, "hex")),
    audienceSha256: sha256(Buffer.from(base)),
    expiresAt: BigInt(inFlightChallenge.expiresAt),
  }, enrolledSigningPublicKey: Buffer.from(
    publicKeys.signingPublicKeyHex, "hex"),
  signature: Buffer.from(inFlightProof.signatureHex, "hex") });
  db.prepare("UPDATE managed_devices SET state='revoked', revoked_at=? " +
    "WHERE household_id=? AND id=?")
    .run(Math.floor(Date.now() / 1000), alpha.householdId,
      proposed.validatedDeviceId);
  const inFlightDenied = await fresh.evaluate(async input => (await fetch(
    "/api/managed/device/binding-proof", { method: "POST",
      credentials: "same-origin", headers: {
        "content-type": "application/json",
        "x-csrf-token": input.csrfToken },
      body: JSON.stringify({ proof: input.proof }) })).status,
  { csrfToken: freshSession.csrfToken, proof: inFlightProof });
  assert.equal(inFlightDenied, 403);
  assert.equal(db.prepare("SELECT consumed_at IS NULL AS unused FROM " +
    "managed_session_device_challenges WHERE household_id=? AND id=?")
    .get(alpha.householdId, inFlightChallenge.challengeId).unused, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM " +
    "managed_session_device_bindings WHERE household_id=? AND session_id=?")
    .get(alpha.householdId, freshSession.sessionId).n, 0);
  const revokedBinding = await fresh.evaluate(async input => (await fetch(
    "/api/managed/device/binding-challenge", { method: "POST",
      credentials: "same-origin", headers: {
        "content-type": "application/json",
        "x-csrf-token": input.csrfToken },
      body: JSON.stringify({ deviceId: input.deviceId }) })).status,
  { csrfToken: freshSession.csrfToken,
    deviceId: proposed.validatedDeviceId });
  assert.equal(revokedBinding, 403);
  await freshContext.close();

  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(existsSync(`${sourcePath}-wal`), false);
  assert.equal(existsSync(`${sourcePath}-shm`), false);
  assert.equal(sha256(readFileSync(sourcePath)), EMPTY_SHA256);
  const serializedCalls = JSON.stringify(rateCalls);
  for (const secret of [password, proposed.comparisonCode])
    assert.equal(serializedCalls.includes(secret), false);
  process.stdout.write("PASS: fictional Chromium login -> device proof -> " +
    "separate owner approval -> session binding; wrong proof/code/family, " +
    `replay and revocation denied. Copy retained at ${copyPath}\n`);
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  if (server) await new Promise(resolve => server.close(resolve));
  db.close();
}

async function browserLogin(page, family, password) {
  return page.evaluate(async input => {
    const login = await fetch("/api/managed/auth/login", { method: "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: input.email,
        householdId: input.householdId, password: input.password }) });
    if (login.status !== 200) throw new Error("Fictional login denied");
    const issued = await login.json();
    const session = await fetch("/api/managed/auth/session", {
      credentials: "same-origin", cache: "no-store", redirect: "error" });
    if (session.status !== 200) throw new Error("Session read denied");
    const current = await session.json();
    for (const key of ["householdId", "accountId", "sessionId", "expiresAt",
      "role", "memberKind"]) {
      if (issued[key] !== current[key]) throw new Error("Session mismatch");
    }
    if (typeof current.csrfToken !== "string" ||
      !current.csrfToken.startsWith("v1."))
      throw new Error("Missing fresh CSRF token");
    return current;
  }, { email: family.email, householdId: family.householdId, password });
}

async function approveInBrowser(page, session, deviceId, code, password) {
  return page.evaluate(async input => (await fetch(
    "/api/managed/device/device-approval", { method: "POST",
      credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "content-type": "application/json",
        "x-csrf-token": input.csrfToken },
      body: JSON.stringify({ deviceId: input.deviceId,
        password: input.password, comparisonCode: input.code }) })).status,
  { deviceId, code, password, csrfToken: session.csrfToken });
}
