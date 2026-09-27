import assert from "node:assert/strict";
import { createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Algorithm, hash } from "@node-rs/argon2";
import { encodeDeviceApprovalCodeMaterialV1,
  formatDeviceApprovalCodeV1, encodeDeviceEnrollmentNonceMaterialV1,
  encodeDeviceEnrollmentProofV1, encodeDeviceEnrollmentProofWireV1,
  encodeSessionDeviceBindingProofV1, encodeSessionDeviceProofWireV1 } from
  "@adeno/contracts";
import Database from "better-sqlite3";
import express from "express";

import { issueCsrfToken, issueSessionToken, SESSION_COOKIE_NAME } from
  "../dist/auth/cookieSession.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { SqliteOwnerDeviceApprovalCandidate } from
  "../dist/managed/sqliteOwnerDeviceApproval.js";
import { SqliteDeviceEnrollmentCandidate } from
  "../dist/managed/sqliteDeviceEnrollment.js";
import { SqliteSessionDeviceBindingCandidate } from
  "../dist/managed/sqliteSessionDeviceBinding.js";
import { createManagedDeviceRouter } from
  "../dist/managed/managedDeviceRouter.js";

// The exact previously approved empty fictional v10 database is read only.
// All rows below are written to a separate private copy; no migration runs.
const APPROVED_DIRECTORY = "adeno-fictional-managed-fJAg4s";
const APPROVED_EMPTY_SHA256 =
  "2c3ee411bc91d720ffe1586badf071abe9b2ce9e1225b35a4de49a64c5ceb027";
const source = process.argv[2];
const parent = typeof source === "string" ? realpathSync(dirname(source)) : "";
assert.equal(process.env.ADENO_APPROVED_FICTIONAL_MIGRATION, "1");
assert.equal(basename(source), "managed.sqlite3");
assert.equal(basename(parent), APPROVED_DIRECTORY);
assert.equal(dirname(parent), realpathSync(tmpdir()));
assert.equal(realpathSync(source), join(parent, "managed.sqlite3"));
assert.equal(process.env.NODE_ENV === "production", false);
assert.equal(Object.keys(process.env).some((name) => name.startsWith("RAILWAY_")), false);
assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"),
  APPROVED_EMPTY_SHA256);

const root = await mkdtemp(join(tmpdir(), "adeno-fictional-device-approval-"));
const path = join(root, "managed.sqlite3");
await copyFile(source, path);
await chmod(path, 0o600);
const db = new Database(path, { fileMustExist: true });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
assertManagedSchema(db);
const now = Math.floor(Date.now() / 1000);
const audience = "https://fictional.example";
const x25519SpkiPrefix = Buffer.from("302a300506032b656e032100", "hex");
const id = (digit) => digit.repeat(32);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const password = "fictional-owner-password-only";
const passwordHash = await hash(password, { algorithm: Algorithm.Argon2id,
  memoryCost: 65_536, timeCost: 3, parallelism: 4, outputLen: 32 });
const otherHash = await hash("fictional-changed-password", {
  algorithm: Algorithm.Argon2id, memoryCost: 65_536, timeCost: 3,
  parallelism: 4, outputLen: 32 });

function family(householdId, accountId, sessionId, email, role = "owner") {
  db.prepare("INSERT INTO managed_families (id,state,created_at) " +
    "VALUES (?,'active',?)").run(householdId, now);
  return account(householdId, accountId, sessionId, email, role);
}

function account(householdId, accountId, sessionId, email, role) {
  db.prepare("INSERT INTO managed_accounts " +
    "(id,login_email,password_hash,state,email_verified_at,created_at) " +
    "VALUES (?,?,?,'active',?,?)")
    .run(accountId, email, passwordHash, now, now);
  db.prepare("INSERT INTO managed_memberships " +
    "(household_id,account_id,member_kind,role,state,created_at) " +
    "VALUES (?,?,?,?,'active',?)")
    .run(householdId, accountId, role === "child" ? "child" : "adult",
      role, now);
  const issued = issueSessionToken();
  const csrfSecret = randomBytes(32);
  db.prepare("INSERT INTO managed_sessions " +
    "(household_id,id,account_id,token_sha256,csrf_secret," +
    "account_auth_version,membership_auth_version,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,1,?,?)")
    .run(householdId, sessionId, accountId,
      Buffer.from(issued.sha256, "hex"), csrfSecret, now, now + 3600);
  return { householdId, accountId, sessionId,
    cookieToken: issued.plaintext,
    preflight: { ok: true, tokenSha256: issued.sha256,
      csrfToken: issueCsrfToken(sessionId, csrfSecret) } };
}

function pending(owner, deviceId, options = {}) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const createdAt = options.expiresSoon ? issuedAt - 597 : issuedAt;
  const expiresAt = options.expiresSoon ? issuedAt + 3 : issuedAt + 600;
  const encryptionPublicKey = randomBytes(32);
  const signingPublicKey = randomBytes(32);
  db.prepare("INSERT INTO managed_enrollment_challenges " +
    "(household_id,id,account_id,session_id,challenge_sha256," +
    "encryption_public_key,signing_public_key,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)")
    .run(owner.householdId, deviceId, owner.accountId, owner.sessionId,
      randomBytes(32), encryptionPublicKey, signingPublicKey,
      createdAt, expiresAt);
  db.prepare("INSERT INTO managed_devices " +
    "(household_id,id,account_id,enrollment_challenge_id,state," +
    "encryption_public_key,signing_public_key,created_at) " +
    "VALUES (?,?,?,?,'pending',?,?,?)")
    .run(owner.householdId, deviceId, owner.accountId, deviceId,
      encryptionPublicKey, signingPublicKey, createdAt);
  db.prepare("UPDATE managed_enrollment_challenges " +
    "SET consumed_at=?, proof_signature=? WHERE household_id=? AND id=?")
    .run(createdAt, randomBytes(64), owner.householdId, deviceId);
  const material = encodeDeviceApprovalCodeMaterialV1({
    householdId: owner.householdId, accountId: owner.accountId,
    deviceId, encryptionPublicKey, signingPublicKey,
  });
  const comparisonCode = formatDeviceApprovalCodeV1(
    createHash("sha256").update(material).digest());
  return { deviceId, comparisonCode, expiresAt };
}

function provedPending(owner) {
  const encryption = generateKeyPairSync("x25519");
  const signing = generateKeyPairSync("ed25519");
  const encryptionPublicKey = encryption.publicKey.export({
    format: "der", type: "spki" }).subarray(-32);
  const signingPublicKey = signing.publicKey.export({
    format: "der", type: "spki" }).subarray(-32);
  const enrollment = new SqliteDeviceEnrollmentCandidate(db, audience);
  const challenge = enrollment.issueWire({ ...owner.preflight,
    encryptionPublicKeyHex: encryptionPublicKey.toString("hex"),
    signingPublicKeyHex: signingPublicKey.toString("hex") });
  const ephemeral = createPublicKey({ key: Buffer.concat([x25519SpkiPrefix,
    Buffer.from(challenge.ephemeralPublicKeyHex, "hex")]),
    format: "der", type: "spki" });
  const sharedSecret = diffieHellman({ privateKey: encryption.privateKey,
    publicKey: ephemeral });
  const audienceSha256 = sha256(Buffer.from(audience)).toString("hex");
  const material = encodeDeviceEnrollmentNonceMaterialV1({ sharedSecret,
    challengeId: challenge.challengeId, audienceSha256 });
  const nonce = sha256(material);
  sharedSecret.fill(0);
  material.fill(0);
  const payload = encodeDeviceEnrollmentProofV1({
    householdId: challenge.householdId, accountId: challenge.accountId,
    sessionId: challenge.sessionId, challengeId: challenge.challengeId,
    nonceSha256: sha256(nonce).toString("hex"), audienceSha256,
    encryptionPublicKeyHex: challenge.encryptionPublicKeyHex,
    signingPublicKeyHex: challenge.signingPublicKeyHex,
    expiresAt: BigInt(challenge.expiresAt),
  });
  const proof = encodeDeviceEnrollmentProofWireV1({
    challengeId: challenge.challengeId, nonce,
    signature: sign(null, Buffer.from(payload), signing.privateKey),
  });
  assert.deepEqual(enrollment.proveWire({ ...owner.preflight, proof }),
    { deviceId: challenge.challengeId, state: "pending" });
  const codeMaterial = encodeDeviceApprovalCodeMaterialV1({
    householdId: owner.householdId, accountId: owner.accountId,
    deviceId: challenge.challengeId, encryptionPublicKey, signingPublicKey,
  });
  return { deviceId: challenge.challengeId,
    comparisonCode: formatDeviceApprovalCodeV1(sha256(codeMaterial)),
    expiresAt: challenge.expiresAt, signingPrivateKey: signing.privateKey };
}

function state(householdId, deviceId) {
  return db.prepare("SELECT state FROM managed_devices " +
    "WHERE household_id=? AND id=?").get(householdId, deviceId)?.state;
}

function approval(preflight, candidate, override = {}) {
  return { ...preflight, deviceId: candidate.deviceId,
    comparisonCode: candidate.comparisonCode, password, ...override };
}

async function denied(service, input) {
  await assert.rejects(service.approve(input), (error) => error?.name ===
    "ManagedOwnerDeviceApprovalDenied");
}

let httpServer;
try {
  const alpha = family(id("1"), id("2"), id("3"),
    "fictional-alpha-owner@example.invalid");
  const alphaChild = account(alpha.householdId, id("4"), id("5"),
    "fictional-alpha-child@example.invalid", "child");
  const beta = family(id("6"), id("7"), id("8"),
    "fictional-beta-owner@example.invalid");
  const service = new SqliteOwnerDeviceApprovalCandidate(db);
  const binder = new SqliteSessionDeviceBindingCandidate(db, audience);
  const first = provedPending(alpha);
  assert.throws(() => binder.issueWire({ ...alpha.preflight,
    deviceId: first.deviceId }), (error) => error?.name ===
      "ManagedSessionDeviceBindingDenied");
  await denied(service, approval(alpha.preflight, first,
    { password: "wrong-fictional-password" }));
  await denied(service, approval({ ...alpha.preflight, csrfToken: "wrong" },
    first));
  await denied(service, approval(alpha.preflight, first,
    { comparisonCode: `${first.comparisonCode[0] === "0" ? "1" : "0"}${first.comparisonCode.slice(1)}` }));
  await denied(service, approval(alphaChild.preflight, first));
  await denied(service, approval(beta.preflight, first));
  assert.equal(state(alpha.householdId, first.deviceId), "pending");
  const app = express();
  let router;
  app.use("/api/managed/device", (request, response, next) =>
    router(request, response, next));
  httpServer = await new Promise((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  const httpOrigin = `http://127.0.0.1:${address.port}`;
  router = createManagedDeviceRouter({ expectedOrigin: httpOrigin,
    enrollment: new SqliteDeviceEnrollmentCandidate(db, httpOrigin),
    approval: service,
    binding: new SqliteSessionDeviceBindingCandidate(db, httpOrigin),
    rateLimit: () => true });
  const approved = await fetch(`${httpOrigin}/api/managed/device/device-approval`, {
    method: "POST", headers: { origin: httpOrigin,
      "sec-fetch-site": "same-origin", "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${alpha.cookieToken}`,
      "x-csrf-token": alpha.preflight.csrfToken },
    body: JSON.stringify({ deviceId: first.deviceId, password,
      comparisonCode: first.comparisonCode.toUpperCase() }),
  });
  assert.equal(approved.status, 204);
  assert.equal(approved.headers.get("set-cookie"), null);
  assert.equal(state(alpha.householdId, first.deviceId), "active");
  const bindingChallenge = binder.issueWire({ ...alpha.preflight,
    deviceId: first.deviceId });
  assert.equal(bindingChallenge.deviceId, first.deviceId);
  const bindingNonce = Buffer.from(bindingChallenge.nonceHex, "hex");
  const bindingPayload = encodeSessionDeviceBindingProofV1({
    householdId: alpha.householdId, accountId: alpha.accountId,
    sessionId: alpha.sessionId, deviceId: first.deviceId,
    challengeId: bindingChallenge.challengeId,
    nonceSha256: sha256(bindingNonce).toString("hex"),
    audienceSha256: sha256(Buffer.from(audience)).toString("hex"),
    expiresAt: BigInt(bindingChallenge.expiresAt),
  });
  binder.bindWire({ ...alpha.preflight,
    proof: encodeSessionDeviceProofWireV1({
      challengeId: bindingChallenge.challengeId, nonce: bindingNonce,
      signature: sign(null, Buffer.from(bindingPayload),
        first.signingPrivateKey),
    }) });
  assert.equal(db.prepare("SELECT device_id AS deviceId " +
    "FROM managed_session_device_bindings " +
    "WHERE household_id=? AND session_id=?")
    .get(alpha.householdId, alpha.sessionId).deviceId, first.deviceId);
  await denied(service, approval(alpha.preflight, first));

  const child = pending(alphaChild, id("b"));
  assert.deepEqual(await service.approve(approval(alpha.preflight, child)),
    { deviceId: child.deviceId, state: "active" });
  assert.equal(state(alpha.householdId, child.deviceId), "active");

  const expired = pending(alpha, id("c"), { expiresSoon: true });
  while (Math.floor(Date.now() / 1000) <= expired.expiresAt)
    await new Promise((resolve) => setTimeout(resolve, 200));
  await denied(service, approval(alpha.preflight, expired));
  assert.equal(state(alpha.householdId, expired.deviceId), "pending");

  const revokedOriginal = pending(alphaChild, id("d"));
  db.prepare("UPDATE managed_sessions SET revoked_at=? " +
    "WHERE household_id=? AND id=?")
    .run(now, alphaChild.householdId, alphaChild.sessionId);
  await denied(service, approval(alpha.preflight, revokedOriginal));
  assert.equal(state(alpha.householdId, revokedOriginal.deviceId), "pending");

  const revokedOwner = pending(beta, id("9"));
  db.prepare("UPDATE managed_sessions SET revoked_at=? " +
    "WHERE household_id=? AND id=?")
    .run(now, beta.householdId, beta.sessionId);
  await denied(service, approval(beta.preflight, revokedOwner));
  assert.equal(state(beta.householdId, revokedOwner.deviceId), "pending");

  const disabledTarget = account(alpha.householdId, id("0"), id("9"),
    "fictional-alpha-second-child@example.invalid", "child");
  const targetCandidate = pending(disabledTarget, id("9"));
  const targetInFlight = service.approve(approval(alpha.preflight,
    targetCandidate));
  db.prepare("UPDATE managed_memberships SET state='disabled', " +
    "disabled_at=?, auth_version=auth_version+1 " +
    "WHERE household_id=? AND account_id=?")
    .run(Math.floor(Date.now() / 1000), alpha.householdId,
      disabledTarget.accountId);
  await assert.rejects(targetInFlight, (error) => error?.name ===
    "ManagedOwnerDeviceApprovalDenied");
  assert.equal(state(alpha.householdId, targetCandidate.deviceId), "pending");

  const revokedCandidate = pending(alpha, id("0"));
  const deviceInFlight = service.approve(approval(alpha.preflight,
    revokedCandidate));
  db.prepare("UPDATE managed_devices SET state='revoked', revoked_at=? " +
    "WHERE household_id=? AND id=?")
    .run(Math.floor(Date.now() / 1000), alpha.householdId,
      revokedCandidate.deviceId);
  await assert.rejects(deviceInFlight, (error) => error?.name ===
    "ManagedOwnerDeviceApprovalDenied");
  assert.equal(state(alpha.householdId, revokedCandidate.deviceId), "revoked");

  const raced = pending(alpha, id("e"));
  const otherDb = new Database(path, { fileMustExist: true });
  otherDb.pragma("foreign_keys = ON");
  otherDb.pragma("trusted_schema = OFF");
  const otherService = new SqliteOwnerDeviceApprovalCandidate(otherDb);
  let results;
  try {
    results = await Promise.allSettled([
      service.approve(approval(alpha.preflight, raced)),
      otherService.approve(approval(alpha.preflight, raced)),
    ]);
  } finally { otherDb.close(); }
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(state(alpha.householdId, raced.deviceId), "active");

  const changedPassword = pending(alpha, id("f"));
  const inFlight = service.approve(approval(alpha.preflight, changedPassword));
  db.prepare("UPDATE managed_accounts SET password_hash=?, " +
    "auth_version=auth_version+1 WHERE id=?")
    .run(otherHash, alpha.accountId);
  await denied({ approve: () => inFlight }, {});
  assert.equal(state(alpha.householdId, changedPassword.deviceId), "pending");
  assert.equal(db.pragma("foreign_key_check").length, 0);
  assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  console.log("Fictional v10 owner device approval candidate passed; source unchanged.");
} finally {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  db.close();
  assert.equal(createHash("sha256").update(readFileSync(source)).digest("hex"),
    APPROVED_EMPTY_SHA256);
}
