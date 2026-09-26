import assert from "node:assert/strict";
import { createHash, createPublicKey, diffieHellman,
  generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";
import express from "express";
import { encodeDeviceEnrollmentNonceMaterialV1,
  encodeDeviceEnrollmentProofV1,
  encodeDeviceEnrollmentProofWireV1,
  encodeSessionDeviceBindingProofV1,
  encodeSessionDeviceProofWireV1 } from "@adeno/contracts";
import { issueCsrfToken, issueSessionToken } from
  "../dist/auth/cookieSession.js";
import { SESSION_COOKIE_NAME } from "../dist/auth/cookieSession.js";
import { assertManagedSchema } from "../dist/managed/managedSchemaGuard.js";
import { SqliteSessionDeviceBindingCandidate } from
  "../dist/managed/sqliteSessionDeviceBinding.js";
import { SqliteDeviceEnrollmentCandidate } from
  "../dist/managed/sqliteDeviceEnrollment.js";
import { createManagedDeviceRouter } from
  "../dist/managed/managedDeviceRouter.js";
import { SqliteManagedIdentityCandidate } from
  "../dist/managed/sqliteManagedIdentity.js";

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

function expectEnrollmentDenied(fn) {
  assert.throws(fn, (error) => error?.name ===
    "ManagedDeviceEnrollmentDenied");
}

function addSession(family, sessionId, accountVersion = 1,
  membershipVersion = 1) {
  const token = issueSessionToken();
  const csrfSecret = randomBytes(32);
  db.prepare("INSERT INTO managed_sessions " +
    "(household_id,id,account_id,token_sha256,csrf_secret," +
    "account_auth_version,membership_auth_version,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)").run(family.h, sessionId, family.a,
      Buffer.from(token.sha256, "hex"), csrfSecret, accountVersion,
      membershipVersion, now, now + 3600);
  return { sha256: token.sha256, plaintext: token.plaintext,
    csrf: issueCsrfToken(sessionId, csrfSecret) };
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

let httpServer;
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
  const identity = new SqliteManagedIdentityCandidate(db);
  const registrationEmail = "fictional-owner@example.invalid";
  const registrationPassword = "invented-passphrase-for-test-only";
  assert.deepEqual(await identity.registerPendingOwner({
    email: registrationEmail, password: registrationPassword,
  }), { accepted: true });
  const registered = db.prepare("SELECT a.id AS accountId, " +
    "m.household_id AS householdId, a.state AS accountState, " +
    "m.state AS memberState, f.state AS familyState " +
    "FROM managed_accounts a " +
    "JOIN managed_memberships m ON m.account_id=a.id " +
    "JOIN managed_families f ON f.id=m.household_id " +
    "WHERE a.login_email=?").get(registrationEmail);
  assert.equal(registered.accountState, "pending");
  assert.equal(registered.memberState, "pending");
  assert.equal(registered.familyState, "frozen");
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_sessions " +
    "WHERE account_id=?").get(registered.accountId).n, 0);
  await assert.rejects(identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: registered.householdId }),
  (error) => error?.name === "ManagedIdentityDenied");
  assert.deepEqual(await identity.registerPendingOwner({
    email: registrationEmail, password: registrationPassword,
  }), { accepted: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_accounts " +
    "WHERE login_email=?").get(registrationEmail).n, 1);
  assert.deepEqual(await identity.registerPendingOwner({
    email: "fictional-second@example.invalid",
    password: registrationPassword,
  }), { accepted: true });
  const secondRegistered = db.prepare("SELECT m.household_id AS householdId, " +
    "a.state AS accountState, m.state AS memberState, f.state AS familyState " +
    "FROM managed_accounts a JOIN managed_memberships m ON m.account_id=a.id " +
    "JOIN managed_families f ON f.id=m.household_id WHERE a.login_email=?")
    .get("fictional-second@example.invalid");
  assert.notEqual(secondRegistered.householdId, registered.householdId);
  assert.deepEqual([secondRegistered.accountState,
    secondRegistered.memberState, secondRegistered.familyState],
  ["pending", "pending", "frozen"]);
  const passwordBurst = await Promise.allSettled(Array.from({ length: 5 },
    (_, index) => identity.registerPendingOwner({
      email: `fictional-burst-${index}@example.invalid`,
      password: registrationPassword,
    })));
  assert.equal(passwordBurst.filter((result) => result.status === "rejected")
    .length, 1);
  // Fictional test-only email proof setup. No production verification flow
  // exists; this direct SQL state change must never be mounted as an API.
  db.prepare("UPDATE managed_accounts SET state='active', auth_version=2 " +
    "WHERE id=?").run(registered.accountId);
  db.prepare("UPDATE managed_memberships SET state='active', auth_version=2 " +
    "WHERE household_id=? AND account_id=?")
    .run(registered.householdId, registered.accountId);
  db.prepare("UPDATE managed_families SET state='active' WHERE id=?")
    .run(registered.householdId);
  const unverifiedFamily = { h: registered.householdId,
    a: registered.accountId };
  const unverifiedSession = addSession(unverifiedFamily, id("e"), 2, 2);
  addDevice(unverifiedFamily, id("f"), id("d"), id("e"));
  const unverifiedEnrollment = new SqliteDeviceEnrollmentCandidate(db,
    "https://fictional.example");
  expectEnrollmentDenied(() => unverifiedEnrollment.issueWire({
    tokenSha256: unverifiedSession.sha256,
    csrfToken: unverifiedSession.csrf,
    encryptionPublicKeyHex: generateKeyPairSync("x25519").publicKey
      .export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
    signingPublicKeyHex: generateKeyPairSync("ed25519").publicKey
      .export({ format: "der", type: "spki" }).subarray(-32).toString("hex"),
  }));
  expectDenied(() => new SqliteSessionDeviceBindingCandidate(db,
    "https://fictional.example").issueWire({
    tokenSha256: unverifiedSession.sha256,
    csrfToken: unverifiedSession.csrf, deviceId: id("f"),
  }));
  await assert.rejects(identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: registered.householdId }),
  (error) => error?.name === "ManagedIdentityDenied");
  db.prepare("UPDATE managed_accounts SET email_verified_at=?, auth_version=3 " +
    "WHERE id=?").run(now, registered.accountId);
  await assert.rejects(identity.login({ email: registrationEmail,
    password: "wrong-password-for-fiction", householdId: registered.householdId }),
  (error) => error?.name === "ManagedIdentityDenied");
  await assert.rejects(identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: families[0].h }),
  (error) => error?.name === "ManagedIdentityDenied");
  const signedIn = await identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: registered.householdId });
  assert.equal(JSON.stringify(signedIn).includes(signedIn.sessionToken), false);
  const tokenSha256 = digest(Buffer.from(signedIn.sessionToken)).toString("hex");
  assert.equal(identity.readSession(tokenSha256)?.accountId,
    registered.accountId);
  assert.equal(identity.readSession(tokenSha256)?.role, "owner");
  assert.throws(() => identity.logout({ ok: true, tokenSha256,
    csrfToken: "bad" }),
    (error) => error?.name === "ManagedIdentityDenied");
  assert.ok(identity.readSession(tokenSha256));
  identity.logout({ ok: true, tokenSha256,
    csrfToken: signedIn.csrfToken });
  assert.equal(identity.readSession(tokenSha256), null);
  const staleLogin = await identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: registered.householdId });
  db.prepare("UPDATE managed_accounts SET auth_version=4 WHERE id=?")
    .run(registered.accountId);
  assert.equal(identity.readSession(digest(Buffer.from(staleLogin.sessionToken))
    .toString("hex")), null);
  const membershipStaleLogin = await identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: registered.householdId });
  db.prepare("UPDATE managed_memberships SET auth_version=3 " +
    "WHERE household_id=? AND account_id=?")
    .run(registered.householdId, registered.accountId);
  assert.equal(identity.readSession(digest(Buffer.from(
    membershipStaleLogin.sessionToken)).toString("hex")), null);
  const frozenFamilyLogin = await identity.login({ email: registrationEmail,
    password: registrationPassword, householdId: registered.householdId });
  db.prepare("UPDATE managed_families SET state='frozen' WHERE id=?")
    .run(registered.householdId);
  assert.equal(identity.readSession(digest(Buffer.from(
    frozenFamilyLogin.sessionToken)).toString("hex")), null);
  const candidate = new SqliteSessionDeviceBindingCandidate(db,
    "https://fictional.example");
  const [alpha, beta] = families;
  const enrollmentSession = addSession(alpha, id("0"));
  const proposedSigning = generateKeyPairSync("ed25519");
  const proposedEncryption = generateKeyPairSync("x25519");
  const enrollment = new SqliteDeviceEnrollmentCandidate(db,
    "https://fictional.example");
  const signingPublicKeyHex = proposedSigning.publicKey
    .export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const encryptionPublicKeyHex = proposedEncryption.publicKey
    .export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const enrollmentInput = { tokenSha256: enrollmentSession.sha256,
    csrfToken: enrollmentSession.csrf,
    encryptionPublicKeyHex, signingPublicKeyHex };
  expectEnrollmentDenied(() => enrollment.issueWire({ ...enrollmentInput,
    csrfToken: "bad" }));
  expectEnrollmentDenied(() => enrollment.issueWire({ ...enrollmentInput,
    encryptionPublicKeyHex: "00".repeat(32) }));
  const enrollmentChallenge = enrollment.issueWire(enrollmentInput);
  assert.equal(Object.hasOwn(enrollmentChallenge, "nonceHex"), false);
  const makeEnrollmentProof = (key = proposedSigning.privateKey,
    changedEncryptionKey = encryptionPublicKeyHex,
    audience = "https://fictional.example",
    selectedChallenge = enrollmentChallenge) => {
    const ephemeralPublicKey = createPublicKey({ key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      Buffer.from(selectedChallenge.ephemeralPublicKeyHex, "hex"),
    ]), format: "der", type: "spki" });
    const sharedSecret = diffieHellman({
      privateKey: proposedEncryption.privateKey,
      publicKey: ephemeralPublicKey,
    });
    const audienceSha256 = digest(Buffer.from(audience)).toString("hex");
    const material = encodeDeviceEnrollmentNonceMaterialV1({ sharedSecret,
      challengeId: selectedChallenge.challengeId, audienceSha256 });
    const nonce = digest(material);
    const payload = encodeDeviceEnrollmentProofV1({
      householdId: selectedChallenge.householdId,
      accountId: selectedChallenge.accountId,
      sessionId: selectedChallenge.sessionId,
      challengeId: selectedChallenge.challengeId,
      nonceSha256: digest(nonce).toString("hex"),
      audienceSha256,
      encryptionPublicKeyHex: changedEncryptionKey,
      signingPublicKeyHex, expiresAt: BigInt(selectedChallenge.expiresAt),
    });
    return encodeDeviceEnrollmentProofWireV1({
      challengeId: selectedChallenge.challengeId, nonce,
      signature: sign(null, Buffer.from(payload), key),
    });
  };
  const goodEnrollmentProof = makeEnrollmentProof();
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: beta.session.sha256, csrfToken: beta.session.csrf,
    proof: goodEnrollmentProof,
  }));
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey, "11".repeat(32)),
  }));
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: makeEnrollmentProof(generateKeyPairSync("ed25519").privateKey),
  }));
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey,
      encryptionPublicKeyHex, "https://wrong.example"),
  }));
  const thirdPartyEncryptionPublicKeyHex = generateKeyPairSync("x25519")
    .publicKey.export({ format: "der", type: "spki" })
    .subarray(-32).toString("hex");
  const thirdPartyChallenge = enrollment.issueWire({ ...enrollmentInput,
    encryptionPublicKeyHex: thirdPartyEncryptionPublicKeyHex });
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey,
      thirdPartyEncryptionPublicKeyHex, "https://fictional.example",
      thirdPartyChallenge),
  }));
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: { ...goodEnrollmentProof, nonceHex: "00".repeat(32) },
  }));
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: "bad",
    proof: goodEnrollmentProof,
  }));
  assert.equal(db.prepare("SELECT consumed_at FROM managed_enrollment_challenges " +
    "WHERE household_id=? AND id=?")
    .get(alpha.h, enrollmentChallenge.challengeId).consumed_at, null);
  const pending = enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: goodEnrollmentProof,
  });
  assert.deepEqual(pending, { deviceId: enrollmentChallenge.challengeId,
    state: "pending" });
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: goodEnrollmentProof,
  }));
  assert.equal(db.prepare("SELECT state FROM managed_devices " +
    "WHERE household_id=? AND id=?")
    .get(alpha.h, pending.deviceId).state, "pending");
  const duplicateKeyChallenge = enrollment.issueWire(enrollmentInput);
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256, csrfToken: enrollmentSession.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey,
      encryptionPublicKeyHex, "https://fictional.example",
      duplicateKeyChallenge),
  }));
  assert.equal(db.prepare("SELECT consumed_at FROM managed_enrollment_challenges " +
    "WHERE household_id=? AND id=?")
    .get(alpha.h, duplicateKeyChallenge.challengeId).consumed_at, null);
  expectDenied(() => candidate.issueWire({
    tokenSha256: enrollmentSession.sha256,
    csrfToken: enrollmentSession.csrf, deviceId: pending.deviceId,
  }));
  const revokedEnrollmentSession = addSession(alpha, id("f"));
  const revokedEnrollmentChallenge = enrollment.issueWire({
    ...enrollmentInput, tokenSha256: revokedEnrollmentSession.sha256,
    csrfToken: revokedEnrollmentSession.csrf,
  });
  db.prepare("UPDATE managed_sessions SET revoked_at=? " +
    "WHERE household_id=? AND id=?").run(now, alpha.h, id("f"));
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: revokedEnrollmentSession.sha256,
    csrfToken: revokedEnrollmentSession.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey,
      encryptionPublicKeyHex, "https://fictional.example",
      revokedEnrollmentChallenge),
  }));
  const enrollmentCapSession = addSession(alpha, id("a"));
  const capEnrollmentInput = { ...enrollmentInput,
    tokenSha256: enrollmentCapSession.sha256,
    csrfToken: enrollmentCapSession.csrf };
  for (let i = 0; i < 16; i++) enrollment.issueWire(capEnrollmentInput);
  expectEnrollmentDenied(() => enrollment.issueWire(capEnrollmentInput));
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
  const httpSession = addSession(beta, id("0"));
  const alphaHttpSession = addSession(alpha, id("1"));
  const app = express();
  let httpRouter;
  app.use("/api/managed/device", (request, response, next) =>
    httpRouter(request, response, next));
  httpServer = await new Promise((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const httpAddress = httpServer.address();
  assert.ok(httpAddress && typeof httpAddress !== "string");
  const httpOrigin = `http://127.0.0.1:${httpAddress.port}`;
  httpRouter = createManagedDeviceRouter({ expectedOrigin: httpOrigin,
    enrollment: new SqliteDeviceEnrollmentCandidate(db, httpOrigin),
    binding: new SqliteSessionDeviceBindingCandidate(db, httpOrigin),
    rateLimit: () => true });
  const httpPost = (action, body, session = httpSession, origin = httpOrigin,
    extraHeaders = {}) =>
    fetch(`${httpOrigin}/api/managed/device/${action}`, { method: "POST",
      headers: { "content-type": "application/json", origin,
        "sec-fetch-site": "same-origin",
        cookie: `${SESSION_COOKIE_NAME}=${session.plaintext}`,
        "x-csrf-token": session.csrf, ...extraHeaders },
      body: JSON.stringify(body) });
  const crossOrigin = await httpPost("enrollment-challenge", {
    encryptionPublicKeyHex, signingPublicKeyHex,
  }, httpSession, "https://attacker.example");
  assert.equal(crossOrigin.status, 403);
  const wrongCsrf = await httpPost("enrollment-challenge", {
    encryptionPublicKeyHex, signingPublicKeyHex,
  }, httpSession, httpOrigin, { "x-csrf-token": "invalid" });
  assert.equal(wrongCsrf.status, 403);
  const httpChallengeResponse = await httpPost("enrollment-challenge", {
    encryptionPublicKeyHex, signingPublicKeyHex,
  });
  assert.equal(httpChallengeResponse.status, 201);
  assert.equal(httpChallengeResponse.headers.get("cache-control"), "no-store");
  assert.equal(httpChallengeResponse.headers.get("access-control-allow-origin"), null);
  const httpChallenge = await httpChallengeResponse.json();
  const httpEnrollmentProof = makeEnrollmentProof(proposedSigning.privateKey,
    encryptionPublicKeyHex, httpOrigin, httpChallenge);
  assert.equal((await httpPost("enrollment-proof", {
    proof: httpEnrollmentProof,
  }, alphaHttpSession)).status, 403);
  const httpPendingResponse = await httpPost("enrollment-proof", {
    proof: httpEnrollmentProof,
  });
  assert.equal(httpPendingResponse.status, 201);
  const httpPending = await httpPendingResponse.json();
  assert.equal(httpPending.state, "pending");
  assert.equal((await httpPost("binding-challenge", {
    deviceId: httpPending.deviceId })).status, 403);
  const httpBindingResponse = await httpPost("binding-challenge", {
    deviceId: beta.d });
  assert.equal(httpBindingResponse.status, 201);
  const httpBindingChallenge = await httpBindingResponse.json();
  const httpBindingProof = proof(httpBindingChallenge, beta.key, httpOrigin);
  assert.equal((await httpPost("binding-proof", {
    proof: httpBindingProof,
  }, alphaHttpSession)).status, 403);
  assert.equal((await httpPost("binding-proof", {
    proof: httpBindingProof })).status, 204);
  assert.equal((await httpPost("binding-proof", {
    proof: httpBindingProof })).status, 403);
  await new Promise((resolve) => httpServer.close(resolve));
  httpServer = undefined;
  const accountDisabledChallenge = enrollment.issueWire(enrollmentInput);
  db.prepare("UPDATE managed_accounts SET state='disabled', auth_version=2 " +
    "WHERE id=?").run(alpha.a);
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: enrollmentSession.sha256,
    csrfToken: enrollmentSession.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey,
      encryptionPublicKeyHex, "https://fictional.example",
      accountDisabledChallenge),
  }));
  const betaEnrollmentInput = { ...enrollmentInput,
    tokenSha256: beta.session.sha256, csrfToken: beta.session.csrf };
  const membershipDisabledChallenge = enrollment.issueWire(betaEnrollmentInput);
  db.prepare("UPDATE managed_memberships SET state='disabled', " +
    "auth_version=2, disabled_at=? WHERE household_id=? AND account_id=?")
    .run(now, beta.h, beta.a);
  expectEnrollmentDenied(() => enrollment.proveWire({
    tokenSha256: beta.session.sha256, csrfToken: beta.session.csrf,
    proof: makeEnrollmentProof(proposedSigning.privateKey,
      encryptionPublicKeyHex, "https://fictional.example",
      membershipDisabledChallenge),
  }));
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  console.log("PASS: fictional pending signup, verified-only login and session revocation; two-family enrollment/binding over HTTP/SQLite; cross-family/replay/revocation/cap denial; day-intent bound-device guard");
} finally {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  // Preserve the approved empty database; never delete it or any records.
  db.exec("ROLLBACK");
  db.close();
}
