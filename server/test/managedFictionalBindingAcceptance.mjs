import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";
import { encodeSessionDeviceBindingProofV1,
  encodeSessionDeviceProofWireV1 } from "@adeno/contracts";
import { issueCsrfToken, issueSessionToken } from
  "../dist/auth/cookieSession.js";
import { assertManagedSchema } from "../dist/managed/managedSchemaGuard.js";
import { SqliteSessionDeviceBindingCandidate } from
  "../dist/managed/sqliteSessionDeviceBinding.js";

// One-time audit of the exact 2026-09-26 approved fictional database. This is
// intentionally not a general-purpose caller-selected database test/runner.
// It never migrates and rolls back all synthetic rows.
const APPROVED_DIRECTORY = "adeno-fictional-managed-fJAg4s";
const APPROVED_EMPTY_SHA256 =
  "2c3ee411bc91d720ffe1586badf071abe9b2ce9e1225b35a4de49a64c5ceb027";
const path = process.argv[2];
const parent = typeof path === "string" ? realpathSync(dirname(path)) : "";
assert.equal(process.env.ADENO_APPROVED_FICTIONAL_MIGRATION, "1");
assert.equal(basename(path), "managed.sqlite3");
assert.equal(basename(parent), APPROVED_DIRECTORY);
assert.equal(dirname(parent), realpathSync(tmpdir()));
assert.equal(process.env.NODE_ENV === "production", false);
assert.equal(Object.keys(process.env).some((name) => name.startsWith("RAILWAY_")), false);
assert.equal(realpathSync(path), join(parent, "managed.sqlite3"));
assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"),
  APPROVED_EMPTY_SHA256);

const db = new Database(path, { fileMustExist: true });
db.pragma("foreign_keys = ON");
db.pragma("trusted_schema = OFF");
assertManagedSchema(db);
assert.equal(db.prepare("SELECT count(*) AS n FROM managed_families").get().n, 0);
const now = Math.floor(Date.now() / 1000);
const id = (byte) => byte.repeat(32);
const digest = (data) => createHash("sha256").update(data).digest();
const families = [
  { h: id("1"), a: id("2"), s: id("3"), d: id("4"), e: id("5"),
    email: "fictional-alpha@example.invalid" },
  { h: id("6"), a: id("7"), s: id("8"), d: id("9"), e: id("a"),
    email: "fictional-beta@example.invalid" },
];

function expectDenied(fn) {
  assert.throws(fn, (error) => error?.name ===
    "ManagedSessionDeviceBindingDenied");
}

function addSession(family, sessionId) {
  const token = issueSessionToken();
  const csrfSecret = randomBytes(32);
  db.prepare("INSERT INTO managed_sessions " +
    "(household_id,id,account_id,token_sha256,csrf_secret," +
    "account_auth_version,membership_auth_version,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,1,?,?)").run(family.h, sessionId, family.a,
      Buffer.from(token.sha256, "hex"), csrfSecret, now, now + 3600);
  return { sha256: token.sha256, csrf: issueCsrfToken(sessionId, csrfSecret) };
}

function addDevice(family, deviceId, enrollmentId, sessionId) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signingKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const encryptionKey = randomBytes(32);
  db.prepare("INSERT INTO managed_enrollment_challenges " +
    "(household_id,id,account_id,session_id,challenge_sha256," +
    "encryption_public_key,signing_public_key,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)").run(family.h, enrollmentId, family.a,
      sessionId, digest(randomBytes(32)), encryptionKey, signingKey,
      now, now + 600);
  db.prepare("INSERT INTO managed_devices " +
    "(household_id,id,account_id,enrollment_challenge_id,state," +
    "encryption_public_key,signing_public_key,created_at) " +
    "VALUES (?,?,?,?,'pending',?,?,?)").run(family.h, deviceId, family.a,
      enrollmentId, encryptionKey, signingKey, now);
  // Enrollment itself has separate runtime proof tests; this fixture only
  // establishes an active enrolled key for binding-service acceptance.
  db.prepare("UPDATE managed_enrollment_challenges " +
    "SET consumed_at=?, proof_signature=? WHERE household_id=? AND id=?")
    .run(now, randomBytes(64), family.h, enrollmentId);
  db.prepare("UPDATE managed_devices SET state='active', activated_at=? " +
    "WHERE household_id=? AND id=?").run(now, family.h, deviceId);
  return privateKey;
}

function proof(challenge, privateKey, audience = "https://fictional.example") {
  const payload = encodeSessionDeviceBindingProofV1({
    householdId: challenge.householdId, accountId: challenge.accountId,
    sessionId: challenge.sessionId, deviceId: challenge.deviceId,
    challengeId: challenge.challengeId,
    nonceSha256: digest(Buffer.from(challenge.nonceHex, "hex")).toString("hex"),
    audienceSha256: digest(Buffer.from(audience)).toString("hex"),
    expiresAt: BigInt(challenge.expiresAt),
  });
  return encodeSessionDeviceProofWireV1({ challengeId: challenge.challengeId,
    nonce: Buffer.from(challenge.nonceHex, "hex"),
    signature: sign(null, Buffer.from(payload), privateKey) });
}

try {
  db.exec("BEGIN IMMEDIATE");
  for (const family of families) {
    db.prepare("INSERT INTO managed_families VALUES (?,'active',?)")
      .run(family.h, now);
    db.prepare("INSERT INTO managed_accounts " +
      "(id,login_email,password_hash,state,email_verified_at,created_at) " +
      "VALUES (?,? ,?,'active',?,?)").run(family.a, family.email,
        "fictional-not-a-real-password-hash-placeholder-000000", now, now);
    db.prepare("INSERT INTO managed_memberships " +
      "(household_id,account_id,member_kind,role,state,created_at) " +
      "VALUES (?,?,'adult','owner','active',?)").run(family.h, family.a, now);
    family.session = addSession(family, family.s);
    family.key = addDevice(family, family.d, family.e, family.s);
  }
  const candidate = new SqliteSessionDeviceBindingCandidate(db,
    "https://fictional.example");
  const [alpha, beta] = families;
  const secondDevice = id("b");
  const secondKey = addDevice(alpha, secondDevice, id("c"), alpha.s);
  const input = { tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, deviceId: alpha.d };
  expectDenied(() => candidate.issueWire({ ...input, deviceId: beta.d }));
  expectDenied(() => candidate.issueWire({ ...input, csrfToken: "bad" }));
  const challenge = candidate.issueWire(input);
  const competingChallenge = candidate.issueWire({ ...input,
    deviceId: secondDevice });
  const fakeIntent = db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,0,1,?,?)");
  const fakeIntentArgs = [alpha.h, id("f"), id("f"), id("f"), id("f"),
    id("f"), alpha.d, alpha.s, now, now + 600];
  assert.throws(() => fakeIntent.run(...fakeIntentArgs),
    /day upload writer is not session-bound/u);
  const bind = (wire) => candidate.bindWire({ tokenSha256: input.tokenSha256,
    csrfToken: input.csrfToken, proof: wire });
  expectDenied(() => bind(proof(challenge, beta.key)));
  expectDenied(() => bind(proof(challenge, secondKey)));
  expectDenied(() => bind(proof(challenge, alpha.key,
    "https://different.example")));
  expectDenied(() => bind({ ...proof(challenge, alpha.key),
    nonceHex: "00".repeat(32) }));
  expectDenied(() => candidate.bindWire({ tokenSha256: input.tokenSha256,
    csrfToken: "bad", proof: proof(challenge, alpha.key) }));
  assert.equal(db.prepare("SELECT consumed_at FROM managed_session_device_challenges " +
    "WHERE household_id=? AND id=?").get(alpha.h, challenge.challengeId)
    .consumed_at, null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_session_device_bindings")
    .get().n, 0);
  const good = proof(challenge, alpha.key);
  bind(good);
  expectDenied(() => bind(proof(competingChallenge, secondKey)));
  // Once bound, the separate scope/key/grant authority still rejects the
  // fictional row. Binding is necessary, never sufficient.
  assert.throws(() => fakeIntent.run(...fakeIntentArgs),
    /day intent key is not active/u);
  expectDenied(() => bind(good));
  expectDenied(() => candidate.issueWire(input));
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_session_device_bindings")
    .get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_session_device_challenges " +
    "WHERE household_id=? AND session_id=? AND consumed_at IS NOT NULL")
    .get(alpha.h, alpha.s).n, 1);

  const betaInput = { tokenSha256: beta.session.sha256,
    csrfToken: beta.session.csrf, deviceId: beta.d };
  const betaChallenge = candidate.issueWire(betaInput);
  expectDenied(() => candidate.bindWire({ tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, proof: proof(betaChallenge, beta.key) }));
  candidate.bindWire({ tokenSha256: beta.session.sha256,
    csrfToken: beta.session.csrf, proof: proof(betaChallenge, beta.key) });
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_session_device_bindings")
    .get().n, 2);

  const freshSession = addSession(alpha, id("d"));
  const freshInput = { tokenSha256: freshSession.sha256,
    csrfToken: freshSession.csrf, deviceId: secondDevice };
  const revokedChallenge = candidate.issueWire(freshInput);
  db.prepare("UPDATE managed_devices SET state='revoked', revoked_at=? " +
    "WHERE household_id=? AND id=?").run(now, alpha.h, secondDevice);
  expectDenied(() => candidate.bindWire({ tokenSha256: freshSession.sha256,
    csrfToken: freshSession.csrf, proof: proof(revokedChallenge, secondKey) }));

  const capSession = addSession(alpha, id("e"));
  const capInput = { tokenSha256: capSession.sha256,
    csrfToken: capSession.csrf, deviceId: alpha.d };
  for (let i = 0; i < 16; i++) candidate.issueWire(capInput);
  expectDenied(() => candidate.issueWire(capInput));
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  console.log("PASS: two fictional families; key/audience/nonce/CSRF/cross-family/replay/revocation/cap; day-intent bound-device guard");
} finally {
  // Preserve the approved empty database; never delete it or any records.
  db.exec("ROLLBACK");
  db.close();
}
