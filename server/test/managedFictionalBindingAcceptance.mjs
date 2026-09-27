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
  encodeSessionDeviceProofWireV1,
  encodeScopeEnvelopeActionPayloadV1,
  encodeScopeEnvelopeBackfillPayloadV1,
  encodeScopeKeyEnvelopeV2,
  encodeManagedVaultBlobV2,
  MANAGED_VAULT_FORMAT_V2,
  MANAGED_VAULT_CHUNK_BYTES,
  SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1,
  SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1 } from "@adeno/contracts";
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
import { createManagedAuthRouter } from
  "../dist/managed/managedAuthRouter.js";
import { SqliteManagedIdentityCandidate } from
  "../dist/managed/sqliteManagedIdentity.js";
import { issueScopeEnvelopeV2 } from
  "../dist/managed/sqliteScopeEnvelopeWriter.js";
import { issueHistoricalScopeEnvelopeV2 } from
  "../dist/managed/sqliteScopeEnvelopeBackfillWriter.js";
import { readAccountScopedScopeEnvelopeCandidateV2 } from
  "../dist/managed/sqliteScopeEnvelopeReader.js";
import { IncompatibleManagedLedger, SqliteManagedUploadLedger } from
  "../dist/managed/sqliteUploadLedger.js";
import { ManagedVaultUploadDeniedError, ManagedVaultUploadExistsError,
  ManagedVaultUploadSessionError } from
  "../dist/managed/ciphertextAdmission.js";
import { ManagedUploadReceiptCsrfError } from
  "../dist/managed/uploadReceipt.js";

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
const sha256Hex = (data) => digest(data).toString("hex");
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

  // SQL-boundary regression: both active devices belong to the same account
  // and have a current contribution grant. Only A is bound to this session.
  // These structurally valid synthetic actions test SQLite guards, not the
  // runtime's separate Ed25519 signature verification.
  const fixtureNow = Math.floor(Date.now() / 1000);
  const profileId = id("a");
  const scopeId = id("b");
  const keyId = id("c");
  const keyCommitment = randomBytes(32);
  db.prepare("INSERT INTO managed_profiles " +
    "(household_id,id,state,created_by_account_id,created_at) " +
    "VALUES (?,?,'active',?,?)")
    .run(alpha.h, profileId, alpha.a, fixtureNow);
  db.prepare("INSERT INTO managed_scopes " +
    "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
    "VALUES (?,?,?,'day','active',?,?)")
    .run(alpha.h, profileId, scopeId, alpha.d, fixtureNow);
  const addSyntheticAction = (() => {
    let counter = 0;
    let predecessor = null;
    const insert = db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)");
    return (kind) => {
      const payloadSha256 = randomBytes(32);
      const actionSha256 = randomBytes(32);
      counter += 1;
      insert.run(alpha.h, alpha.d, counter, kind, payloadSha256,
        predecessor, actionSha256, randomBytes(64), fixtureNow);
      predecessor = actionSha256;
      return { counter, payloadSha256 };
    };
  })();
  const registration = addSyntheticAction("key");
  db.prepare("INSERT INTO managed_key_identities " +
    "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
    "key_commitment,signed_payload_sha256,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,'day',?,?,?,?,?)")
    .run(alpha.h, profileId, scopeId, keyId, keyCommitment,
      registration.payloadSha256, alpha.d, registration.counter, fixtureNow);
  const activation = addSyntheticAction("key");
  db.prepare("INSERT INTO managed_active_key_events " +
    "(household_id,profile_id,scope_id,sequence,previous_sha256," +
    "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
    "key_commitment,registration_sha256,issuer_device_id,session_id," +
    "issuer_counter,created_at) " +
    "VALUES (?,?,?,1,NULL,NULL,NULL,?,?,1,'day',?,?,?,?,?,?)")
    .run(alpha.h, profileId, scopeId, activation.payloadSha256, keyId,
      keyCommitment, registration.payloadSha256, alpha.d, alpha.s,
      activation.counter, fixtureNow);
  for (const deviceId of [alpha.d, secondDevice]) {
    db.prepare("INSERT INTO managed_grant_heads " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "head_sha256,capability_mask,updated_at) " +
      "VALUES (?,?,?,?,0,NULL,0,?)")
      .run(alpha.h, profileId, scopeId, deviceId, fixtureNow);
    const grant = addSyntheticAction("grant");
    db.prepare("INSERT INTO managed_grant_events " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
      "issuer_counter,created_at) " +
      "VALUES (?,?,?,?,1,NULL,?,3,?,?,?)")
      .run(alpha.h, profileId, scopeId, deviceId, grant.payloadSha256,
        alpha.d, grant.counter, fixtureNow);
  }
  const insertAuthorizedIntent = db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,0,1,?,?)");
  const intentArgs = (intentId, blobId, writerDeviceId) => [alpha.h,
    intentId, profileId, scopeId, keyId, blobId, writerDeviceId, alpha.s,
    fixtureNow, fixtureNow + 600];
  insertAuthorizedIntent.run(...intentArgs(id("d"), id("e"), alpha.d));
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_upload_intents " +
    "WHERE household_id=? AND profile_id=? AND scope_id=?")
    .get(alpha.h, profileId, scopeId).n, 1);
  assert.throws(() => insertAuthorizedIntent.run(...intentArgs(id("e"),
    id("f"), secondDevice)), /day upload writer is not session-bound/u);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_upload_intents " +
    "WHERE household_id=? AND profile_id=? AND scope_id=?")
    .get(alpha.h, profileId, scopeId).n, 1);

  // This is a service/SQL-boundary test: the older key/grant actions above
  // are structural fictional fixtures, but every envelope action below is
  // freshly signed by the enrolled Ed25519 key and verified in the writer's
  // own BEGIN IMMEDIATE transaction. HPKE ciphertext remains opaque to SQL.
  const envelopeCounts = () => ({
    actions: db.prepare("SELECT count(*) AS n FROM managed_signed_actions " +
      "WHERE household_id=?").get(alpha.h).n,
    envelopes: db.prepare("SELECT count(*) AS n FROM managed_scope_envelopes_v2 " +
      "WHERE household_id=?").get(alpha.h).n,
  });
  const envelopeCandidate = (issuerDeviceId, issuerPrivateKey,
    recipientDeviceId, sessionId = alpha.s) => {
    const issuerPublic = db.prepare("SELECT signing_public_key AS key " +
      "FROM managed_devices WHERE household_id=? AND id=?")
      .get(alpha.h, issuerDeviceId).key;
    const recipientPublic = db.prepare("SELECT encryption_public_key AS key " +
      "FROM managed_devices WHERE household_id=? AND id=?")
      .get(alpha.h, recipientDeviceId).key;
    const activeHead = db.prepare("SELECT head_sha256 AS head " +
      "FROM managed_current_scope_keys WHERE household_id=? " +
      "AND profile_id=? AND scope_id=?")
      .get(alpha.h, profileId, scopeId).head;
    const grantHead = db.prepare("SELECT head_sha256 AS head " +
      "FROM managed_grant_heads WHERE household_id=? AND profile_id=? " +
      "AND scope_id=? AND subject_device_id=?")
      .get(alpha.h, profileId, scopeId, recipientDeviceId).head;
    const prior = db.prepare("SELECT counter, action_sha256 AS actionSha256 " +
      "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
      "ORDER BY counter DESC LIMIT 1").get(alpha.h, issuerDeviceId);
    const counter = BigInt((prior?.counter ?? 0) + 1);
    const previousActionSha256 = prior?.actionSha256.toString("hex") ?? null;
    const createdAt = BigInt(Math.floor(Date.now() / 1000));
    const recipientKeySha256 = sha256Hex(recipientPublic);
    const wire = encodeScopeKeyEnvelopeV2({
      format: "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2",
      context: { householdId: alpha.h, careProfileId: profileId,
        opaqueScopeId: scopeId, keyId, keyEpoch: 1, purpose: "day",
        recipientDeviceId },
      keyCommitmentSha256: keyCommitment.toString("hex"),
      recipientKeySha256, encapsulatedKey: new Uint8Array(32).fill(4),
      ciphertext: new Uint8Array(48).fill(5).buffer,
    });
    const row = { householdId: alpha.h, careProfileId: profileId,
      opaqueScopeId: scopeId, keyId, keyEpoch: 1, purpose: "day",
      recipientDeviceId, keyCommitmentSha256: keyCommitment.toString("hex"),
      recipientKeySha256, wireVersion: 2, wire, wireSha256: sha256Hex(wire),
      activeKeyHeadSha256: activeHead.toString("hex"),
      grantHeadSha256: grantHead.toString("hex"),
      signedPayloadSha256: "", issuerDeviceId, issuerCounter: counter,
      sessionId, createdAt };
    const payload = encodeScopeEnvelopeActionPayloadV1({
      householdId: row.householdId, careProfileId: row.careProfileId,
      opaqueScopeId: row.opaqueScopeId, keyId: row.keyId,
      keyEpoch: row.keyEpoch, purpose: row.purpose,
      recipientDeviceId: row.recipientDeviceId,
      keyCommitmentSha256: row.keyCommitmentSha256,
      recipientKeySha256: row.recipientKeySha256,
      wireSha256: row.wireSha256,
      activeKeyHeadSha256: row.activeKeyHeadSha256,
      grantHeadSha256: row.grantHeadSha256,
      issuerDeviceId, issuerCounter: counter, sessionId, createdAt,
      previousActionSha256, issuerSigningKeySha256: sha256Hex(issuerPublic),
    });
    const signature = sign(null, Buffer.from(payload), issuerPrivateKey);
    row.signedPayloadSha256 = sha256Hex(payload);
    const action = { householdId: alpha.h, deviceId: issuerDeviceId,
      counter, actionKind: "envelope", payloadSha256: row.signedPayloadSha256,
      previousActionSha256,
      actionSha256: sha256Hex(Buffer.concat([
        Buffer.from(SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1),
        Buffer.from(payload), signature,
      ])), signature, createdAt };
    return { row, action };
  };
  const issueEnvelope = (value, session = alpha.session) =>
    issueScopeEnvelopeV2(db, { tokenSha256: session.sha256,
      csrfToken: session.csrf, ...value });
  const expectEnvelopeDeniedAtomically = (value, session = alpha.session) => {
    const before = envelopeCounts();
    assert.throws(() => issueEnvelope(value, session),
      (error) => error?.name === "ManagedScopeEnvelopeIssueDenied");
    assert.deepEqual(envelopeCounts(), before);
  };
  const beforeEnvelope = envelopeCounts();
  issueEnvelope(envelopeCandidate(alpha.d, alpha.key, alpha.d));
  assert.deepEqual(envelopeCounts(), { actions: beforeEnvelope.actions + 1,
    envelopes: beforeEnvelope.envelopes + 1 });
  const readEnvelope = () => readAccountScopedScopeEnvelopeCandidateV2(db, {
    tokenSha256: alpha.session.sha256, careProfileId: profileId,
    opaqueScopeId: scopeId, keyId, keyEpoch: 1 });
  assert.equal(readEnvelope().kind, "ordinary");
  assert.equal(readEnvelope().row.recipientDeviceId, alpha.d);
  assert.throws(() => readAccountScopedScopeEnvelopeCandidateV2(db, {
    tokenSha256: beta.session.sha256, careProfileId: profileId,
    opaqueScopeId: scopeId, keyId, keyEpoch: 1 }),
  (error) => error?.name === "ManagedScopeEnvelopeReadDenied");
  expectEnvelopeDeniedAtomically(envelopeCandidate(secondDevice, secondKey,
    alpha.d));
  expectEnvelopeDeniedAtomically(envelopeCandidate(alpha.d, alpha.key,
    secondDevice), beta.session);
  const tamperedWire = envelopeCandidate(alpha.d, alpha.key, secondDevice);
  tamperedWire.row.wire = Uint8Array.from(tamperedWire.row.wire);
  tamperedWire.row.wire[239] ^= 1;
  expectEnvelopeDeniedAtomically(tamperedWire);
  const badSignature = envelopeCandidate(alpha.d, alpha.key, secondDevice);
  badSignature.action.signature = Buffer.from(badSignature.action.signature);
  badSignature.action.signature[0] ^= 1;
  const badPayload = encodeScopeEnvelopeActionPayloadV1({
    householdId: badSignature.row.householdId,
    careProfileId: badSignature.row.careProfileId,
    opaqueScopeId: badSignature.row.opaqueScopeId,
    keyId: badSignature.row.keyId, keyEpoch: badSignature.row.keyEpoch,
    purpose: badSignature.row.purpose,
    recipientDeviceId: badSignature.row.recipientDeviceId,
    keyCommitmentSha256: badSignature.row.keyCommitmentSha256,
    recipientKeySha256: badSignature.row.recipientKeySha256,
    wireSha256: badSignature.row.wireSha256,
    activeKeyHeadSha256: badSignature.row.activeKeyHeadSha256,
    grantHeadSha256: badSignature.row.grantHeadSha256,
    issuerDeviceId: badSignature.row.issuerDeviceId,
    issuerCounter: badSignature.row.issuerCounter,
    sessionId: badSignature.row.sessionId,
    createdAt: badSignature.row.createdAt,
    previousActionSha256: badSignature.action.previousActionSha256,
    issuerSigningKeySha256: sha256Hex(db.prepare(
      "SELECT signing_public_key AS key FROM managed_devices " +
      "WHERE household_id=? AND id=?").get(alpha.h, alpha.d).key),
  });
  badSignature.action.actionSha256 = sha256Hex(Buffer.concat([
    Buffer.from(SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1),
    Buffer.from(badPayload), badSignature.action.signature,
  ]));
  expectEnvelopeDeniedAtomically(badSignature);
  // A duplicate recipient/key is rejected after the writer has inserted its
  // new signed action; BEGIN IMMEDIATE must roll that insertion back too.
  expectEnvelopeDeniedAtomically(envelopeCandidate(alpha.d, alpha.key,
    alpha.d));

  const betaInput = { tokenSha256: beta.session.sha256,
    csrfToken: beta.session.csrf, deviceId: beta.d };
  const betaChallenge = candidate.issueWire(betaInput);
  expectDenied(() => candidate.bindWire({ tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, proof: proof(betaChallenge, beta.key) }));
  candidate.bindWire({ tokenSha256: beta.session.sha256,
    csrfToken: beta.session.csrf, proof: proof(betaChallenge, beta.key) });
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_session_device_bindings")
    .get().n, 2);

  // The ledger borrows the same already-private, integrity-checked connection
  // as other managed services. Its nested transactions must not publish or
  // close the outer fictional BEGIN/ROLLBACK transaction.
  const ledger = new SqliteManagedUploadLedger({ connection: db }, 1000);
  assert.equal(db.inTransaction, true);
  const sessionView = (family) => ({
    scope: { householdId: family.h, userId: family.a },
    sessionId: family.s,
    csrfSecret: db.prepare("SELECT csrf_secret AS value FROM managed_sessions " +
      "WHERE household_id=? AND id=?").get(family.h, family.s).value,
    expiresAt: now + 3600,
  });
  const uploadSignal = new AbortController().signal;
  const firstReceiptInput = { tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, intentId: id("d"), blobId: id("e") };
  assert.deepEqual(await ledger.readReceipt(firstReceiptInput),
    { status: "unconfirmed" });
  await assert.rejects(ledger.readReceipt({ ...firstReceiptInput,
    csrfToken: "fictional-wrong-csrf" }), ManagedUploadReceiptCsrfError);
  assert.equal(await ledger.readReceipt({ ...firstReceiptInput,
    blobId: id("9") }), null);
  assert.equal(await ledger.readReceipt({ ...firstReceiptInput,
    tokenSha256: beta.session.sha256, csrfToken: beta.session.csrf }), null);
  assert.equal(await ledger.openForStaging({ session: sessionView(beta),
    tokenSha256: beta.session.sha256, csrfToken: beta.session.csrf,
    intentId: id("d"), signal: uploadSignal }), null);
  const stagedFirst = await ledger.openForStaging({
    session: sessionView(alpha), tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, intentId: id("d"), signal: uploadSignal });
  assert.ok(stagedFirst);
  assert.equal(stagedFirst.blobId, id("e"));
  assert.equal(db.inTransaction, true);
  assert.deepEqual(await ledger.readReceipt(firstReceiptInput),
    { status: "unconfirmed" });
  const firstIv = Buffer.alloc(12, 1);
  const firstCiphertext = new Uint8Array(16).fill(2);
  const firstWire = encodeManagedVaultBlobV2({
    format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(id("e"), "hex"), plaintextSize: 0,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [{ iv: firstIv, ciphertext: firstCiphertext.buffer }],
  });
  assert.equal(firstWire.byteLength, 65);
  const firstWireSha = digest(firstWire);
  await ledger.publishVerified({ intent: stagedFirst,
    tokenSha256: alpha.session.sha256, csrfToken: alpha.session.csrf,
    wireSha256: firstWireSha, wireBytes: firstWire.byteLength,
    chunks: [{ index: 0, iv: firstIv, storageObjectId: id("5"),
      ciphertextSha256: digest(firstCiphertext), ciphertextBytes: 16 }],
    signal: uploadSignal });
  assert.equal(db.inTransaction, true);
  assert.deepEqual(await ledger.readReceipt(firstReceiptInput), {
    status: "committed", wireSha256: firstWireSha.toString("hex"),
    wireBytes: 65,
  });
  db.pragma("trusted_schema = ON");
  try {
    await assert.rejects(ledger.readReceipt(firstReceiptInput),
      IncompatibleManagedLedger);
  } finally { db.pragma("trusted_schema = OFF"); }
  for (const [table, condition] of [
    ["managed_staging_leases", "committed_at IS NOT NULL"],
    ["managed_nonce_reservations", "1=1"],
    ["managed_blob_chunks", "1=1"],
    ["managed_committed_blobs", "1=1"],
  ]) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table} ` +
    `WHERE household_id=? AND ${condition}`).get(alpha.h).n, 1);
  assert.notEqual(db.prepare("SELECT consumed_at AS value FROM managed_upload_intents " +
    "WHERE household_id=? AND id=?").get(alpha.h, id("d")).value, null);
  assert.equal(db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
    "FROM managed_wire_occupancy WHERE household_id=?")
    .get(alpha.h).bytes, 65);
  assert.equal(await ledger.openForStaging({
    session: sessionView(alpha), tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, intentId: id("d"),
    signal: uploadSignal }), null);

  const secondIntentAt = Math.floor(Date.now() / 1000);
  insertAuthorizedIntent.run(alpha.h, id("f"), profileId, scopeId,
    keyId, id("9"), alpha.d, alpha.s, secondIntentAt,
    secondIntentAt + 600);
  const strictLedger = new SqliteManagedUploadLedger({ connection: db }, 65);
  await assert.rejects(strictLedger.openForStaging({
    session: sessionView(alpha), tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, intentId: id("f"),
    signal: uploadSignal }), ManagedVaultUploadDeniedError);
  strictLedger.close();
  assert.equal(db.inTransaction, true);
  const stagedSecond = await ledger.openForStaging({
    session: sessionView(alpha), tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, intentId: id("f"),
    signal: uploadSignal });
  assert.ok(stagedSecond);
  const secondWire = encodeManagedVaultBlobV2({
    format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(id("9"), "hex"), plaintextSize: 0,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [{ iv: firstIv, ciphertext: firstCiphertext.buffer }],
  });
  await assert.rejects(ledger.publishVerified({ intent: stagedSecond,
    tokenSha256: alpha.session.sha256, csrfToken: alpha.session.csrf,
    wireSha256: digest(secondWire), wireBytes: secondWire.byteLength,
    chunks: [{ index: 0, iv: firstIv, storageObjectId: id("6"),
      ciphertextSha256: digest(firstCiphertext), ciphertextBytes: 16 }],
    signal: uploadSignal }), ManagedVaultUploadExistsError);
  for (const table of ["managed_nonce_reservations", "managed_blob_chunks",
    "managed_committed_blobs"]) assert.equal(db.prepare(
    `SELECT count(*) AS n FROM ${table} WHERE household_id=? AND intent_id=?`)
    .get(alpha.h, id("f")).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=? AND intent_id=? AND committed_at IS NULL")
    .get(alpha.h, id("f")).n, 1);
  assert.deepEqual(await ledger.readReceipt({
    tokenSha256: alpha.session.sha256, csrfToken: alpha.session.csrf,
    intentId: id("f"), blobId: id("9") }), { status: "unconfirmed" });
  assert.equal(db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
    "FROM managed_wire_occupancy WHERE household_id=?")
    .get(alpha.h).bytes, 130); // The failed attempt's lease remains charged.

  // A later-chunk nonce collision must roll back the earlier chunk's nonce
  // and metadata inserts, while leaving the failed staging lease charged.
  const multiIntentId = id("8");
  const multiBlobId = id("a");
  const multiPlaintextBytes = MANAGED_VAULT_CHUNK_BYTES + 1;
  const multiAt = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,?,2,?,?)")
    .run(alpha.h, multiIntentId, profileId, scopeId, keyId, multiBlobId,
      alpha.d, alpha.s, multiPlaintextBytes, multiAt, multiAt + 600);
  const multiLedger = new SqliteManagedUploadLedger({ connection: db },
    2 * MANAGED_VAULT_CHUNK_BYTES);
  const stagedMulti = await multiLedger.openForStaging({
    session: sessionView(alpha), tokenSha256: alpha.session.sha256,
    csrfToken: alpha.session.csrf, intentId: multiIntentId,
    signal: uploadSignal });
  assert.ok(stagedMulti);
  const multiFirstIv = Buffer.alloc(12, 4);
  const multiFirstCiphertext = new Uint8Array(MANAGED_VAULT_CHUNK_BYTES + 16)
    .fill(4);
  const multiLastCiphertext = new Uint8Array(17).fill(5);
  const multiWire = encodeManagedVaultBlobV2({
    format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(multiBlobId, "hex"),
    plaintextSize: multiPlaintextBytes,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [
      { iv: multiFirstIv, ciphertext: multiFirstCiphertext.buffer },
      { iv: firstIv, ciphertext: multiLastCiphertext.buffer },
    ],
  });
  await assert.rejects(multiLedger.publishVerified({ intent: stagedMulti,
    tokenSha256: alpha.session.sha256, csrfToken: alpha.session.csrf,
    wireSha256: digest(multiWire), wireBytes: multiWire.byteLength,
    chunks: [
      { index: 0, iv: multiFirstIv, storageObjectId: id("b"),
        ciphertextSha256: digest(multiFirstCiphertext),
        ciphertextBytes: multiFirstCiphertext.byteLength },
      { index: 1, iv: firstIv, storageObjectId: id("c"),
        ciphertextSha256: digest(multiLastCiphertext),
        ciphertextBytes: multiLastCiphertext.byteLength },
    ], signal: uploadSignal }), ManagedVaultUploadExistsError);
  for (const table of ["managed_nonce_reservations", "managed_blob_chunks",
    "managed_committed_blobs"]) assert.equal(db.prepare(
    `SELECT count(*) AS n FROM ${table} WHERE household_id=? AND intent_id=?`)
    .get(alpha.h, multiIntentId).n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_staging_leases " +
    "WHERE household_id=? AND intent_id=? AND committed_at IS NULL")
    .get(alpha.h, multiIntentId).n, 1);
  assert.equal(db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes " +
    "FROM managed_wire_occupancy WHERE household_id=?")
    .get(alpha.h).bytes, 130 + multiWire.byteLength);
  assert.deepEqual(await multiLedger.readReceipt({
    tokenSha256: alpha.session.sha256, csrfToken: alpha.session.csrf,
    intentId: multiIntentId, blobId: multiBlobId }),
  { status: "unconfirmed" });
  multiLedger.close();
  assert.equal(db.inTransaction, true);

  // Separate historical-key backfill fixture. These old key/grant actions are
  // invented structural SQL rows; the backfill action itself is freshly
  // Ed25519-signed and checked by the unmounted writer in one transaction.
  const historicalScopeId = id("3");
  const historicalKeyId = id("4");
  const currentKeyId = id("5");
  const historicalCommitment = randomBytes(32);
  const currentCommitment = randomBytes(32);
  const appendStructuralAction = (kind) => {
    const prior = db.prepare("SELECT counter, action_sha256 AS hash " +
      "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
      "ORDER BY counter DESC LIMIT 1").get(alpha.h, alpha.d);
    const counter = (prior?.counter ?? 0) + 1;
    const payloadHash = randomBytes(32);
    const actionHash = randomBytes(32);
    const createdAt = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)")
      .run(alpha.h, alpha.d, counter, kind, payloadHash,
        prior?.hash ?? null, actionHash, randomBytes(64), createdAt);
    return { counter, payloadHash, actionHash, createdAt };
  };
  db.prepare("INSERT INTO managed_scopes " +
    "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
    "VALUES (?,?,?,'day','active',?,?)")
    .run(alpha.h, profileId, historicalScopeId, alpha.d,
      Math.floor(Date.now() / 1000));
  const registerHistorical = appendStructuralAction("key");
  db.prepare("INSERT INTO managed_key_identities " +
    "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
    "key_commitment,signed_payload_sha256,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,'day',?,?,?,?,?)")
    .run(alpha.h, profileId, historicalScopeId, historicalKeyId,
      historicalCommitment, registerHistorical.payloadHash, alpha.d,
      registerHistorical.counter, registerHistorical.createdAt);
  const activateHistorical = appendStructuralAction("key");
  db.prepare("INSERT INTO managed_active_key_events " +
    "(household_id,profile_id,scope_id,sequence,previous_sha256," +
    "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
    "key_commitment,registration_sha256,issuer_device_id,session_id," +
    "issuer_counter,created_at) VALUES " +
    "(?,?,?,1,NULL,NULL,NULL,?,?,1,'day',?,?,?,?,?,?)")
    .run(alpha.h, profileId, historicalScopeId,
      activateHistorical.payloadHash, historicalKeyId,
      historicalCommitment, registerHistorical.payloadHash,
      alpha.d, alpha.s, activateHistorical.counter,
      activateHistorical.createdAt);
  const registerCurrent = appendStructuralAction("key");
  db.prepare("INSERT INTO managed_key_identities " +
    "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
    "key_commitment,signed_payload_sha256,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,2,'day',?,?,?,?,?)")
    .run(alpha.h, profileId, historicalScopeId, currentKeyId,
      currentCommitment, registerCurrent.payloadHash, alpha.d,
      registerCurrent.counter, registerCurrent.createdAt);
  const activateCurrent = appendStructuralAction("key");
  db.prepare("INSERT INTO managed_active_key_events " +
    "(household_id,profile_id,scope_id,sequence,previous_sha256," +
    "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
    "key_commitment,registration_sha256,issuer_device_id,session_id," +
    "issuer_counter,created_at) VALUES " +
    "(?,?,?,2,?,?,1,?,?,2,'day',?,?,?,?,?,?)")
    .run(alpha.h, profileId, historicalScopeId,
      activateHistorical.payloadHash, historicalKeyId,
      activateCurrent.payloadHash, currentKeyId,
      currentCommitment, registerCurrent.payloadHash,
      alpha.d, alpha.s, activateCurrent.counter, activateCurrent.createdAt);
  const historicalRecipientSession = addSession(alpha, id("6"));
  const recipientChallenge = candidate.issueWire({
    tokenSha256: historicalRecipientSession.sha256,
    csrfToken: historicalRecipientSession.csrf, deviceId: secondDevice });
  candidate.bindWire({ tokenSha256: historicalRecipientSession.sha256,
    csrfToken: historicalRecipientSession.csrf,
    proof: proof(recipientChallenge, secondKey) });
  db.prepare("INSERT INTO managed_grant_heads " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "head_sha256,capability_mask,updated_at) VALUES (?,?,?,?,0,NULL,0,?)")
    .run(alpha.h, profileId, historicalScopeId, secondDevice,
      Math.floor(Date.now() / 1000));
  const historicalGrant = appendStructuralAction("grant");
  db.prepare("INSERT INTO managed_grant_events " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,NULL,?,1,?,?,?)")
    .run(alpha.h, profileId, historicalScopeId, secondDevice,
      historicalGrant.payloadHash, alpha.d, historicalGrant.counter,
      historicalGrant.createdAt);
  const historicalCounts = () => ({
    actions: db.prepare("SELECT count(*) AS n FROM managed_signed_actions " +
      "WHERE household_id=?").get(alpha.h).n,
    backfills: db.prepare("SELECT count(*) AS n " +
      "FROM managed_scope_envelope_backfills_v2 WHERE household_id=?")
      .get(alpha.h).n,
  });
  const historicalCandidate = (issuerDeviceId = alpha.d,
    issuerPrivateKey = alpha.key, issuerHouseholdId = alpha.h,
    sessionId = alpha.s, options = {}) => {
    const issuerPublic = db.prepare("SELECT signing_public_key AS value " +
      "FROM managed_devices WHERE household_id=? AND id=?")
      .get(issuerHouseholdId, issuerDeviceId).value;
    const recipientPublic = db.prepare("SELECT encryption_public_key AS value " +
      "FROM managed_devices WHERE household_id=? AND id=?")
      .get(alpha.h, secondDevice).value;
    const prior = db.prepare("SELECT counter, action_sha256 AS hash " +
      "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
      "ORDER BY counter DESC LIMIT 1")
      .get(issuerHouseholdId, issuerDeviceId);
    const issuerCounter = BigInt((prior?.counter ?? 0) + 1) +
      (options.counterOffset ?? 0n);
    const previousActionSha256 = options.previousActionSha256 ??
      (prior?.hash.toString("hex") ?? null);
    const createdAt = options.createdAt ??
      BigInt(Math.floor(Date.now() / 1000));
    const recipientKeySha256 = sha256Hex(recipientPublic);
    const wire = encodeScopeKeyEnvelopeV2({
      format: "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2",
      context: { householdId: alpha.h, careProfileId: profileId,
        opaqueScopeId: historicalScopeId, keyId: historicalKeyId,
        keyEpoch: 1, purpose: "day", recipientDeviceId: secondDevice },
      keyCommitmentSha256: historicalCommitment.toString("hex"),
      recipientKeySha256, encapsulatedKey: new Uint8Array(32).fill(8),
      ciphertext: new Uint8Array(48).fill(9).buffer,
    });
    const row = { householdId: alpha.h, careProfileId: profileId,
      opaqueScopeId: historicalScopeId, keyId: historicalKeyId,
      keyEpoch: 1, purpose: "day", recipientDeviceId: secondDevice,
      keyCommitmentSha256: historicalCommitment.toString("hex"),
      recipientKeySha256, wireVersion: 2, wire,
      wireSha256: sha256Hex(wire), historicalActivationSequence: 1n,
      historicalActivationSha256:
        activateHistorical.payloadHash.toString("hex"),
      currentActiveKeySequence: 2n,
      currentActiveKeyHeadSha256: activateCurrent.payloadHash.toString("hex"),
      currentGrantSequence: 1n,
      currentGrantHeadSha256: historicalGrant.payloadHash.toString("hex"),
      signedPayloadSha256: "", issuerDeviceId, issuerCounter,
      sessionId, createdAt };
    const payload = encodeScopeEnvelopeBackfillPayloadV1({
      householdId: row.householdId, careProfileId: row.careProfileId,
      opaqueScopeId: row.opaqueScopeId, keyId: row.keyId,
      keyEpoch: row.keyEpoch, purpose: row.purpose,
      recipientDeviceId: row.recipientDeviceId,
      keyCommitmentSha256: row.keyCommitmentSha256,
      recipientKeySha256: row.recipientKeySha256,
      wireSha256: row.wireSha256,
      historicalActivationSequence: row.historicalActivationSequence,
      historicalActivationSha256: row.historicalActivationSha256,
      currentActiveKeySequence: row.currentActiveKeySequence,
      activeKeyHeadSha256: row.currentActiveKeyHeadSha256,
      currentGrantSequence: row.currentGrantSequence,
      grantHeadSha256: row.currentGrantHeadSha256,
      issuerDeviceId, issuerCounter, sessionId: row.sessionId, createdAt,
      previousActionSha256, issuerSigningKeySha256: sha256Hex(issuerPublic),
    });
    const signature = sign(null, Buffer.from(payload), issuerPrivateKey);
    row.signedPayloadSha256 = sha256Hex(payload);
    const action = { householdId: alpha.h, deviceId: issuerDeviceId,
      counter: issuerCounter, actionKind: "envelope",
      payloadSha256: row.signedPayloadSha256, previousActionSha256,
      actionSha256: sha256Hex(Buffer.concat([
        Buffer.from(SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1),
        Buffer.from(payload), signature,
      ])), signature, createdAt };
    return { row, action };
  };
  const issueHistorical = (value, session = alpha.session) =>
    issueHistoricalScopeEnvelopeV2(db, { tokenSha256: session.sha256,
      csrfToken: session.csrf, ...value });
  const expectHistoricalDeniedAtomically = (value, session = alpha.session) => {
    const before = historicalCounts();
    assert.throws(() => issueHistorical(value, session),
      (error) => error?.name === "ManagedScopeEnvelopeBackfillIssueDenied");
    assert.deepEqual(historicalCounts(), before);
  };
  expectHistoricalDeniedAtomically(historicalCandidate(beta.d, beta.key,
    beta.h, beta.s), beta.session);
  expectHistoricalDeniedAtomically(historicalCandidate(secondDevice, secondKey));
  const tamperedHistorical = historicalCandidate();
  tamperedHistorical.row.wire = Uint8Array.from(tamperedHistorical.row.wire);
  tamperedHistorical.row.wire[239] ^= 1;
  expectHistoricalDeniedAtomically(tamperedHistorical);
  const badHistoricalSignature = historicalCandidate();
  badHistoricalSignature.action.signature = Buffer.from(
    badHistoricalSignature.action.signature);
  badHistoricalSignature.action.signature[0] ^= 1;
  const signedHistoricalPayload = encodeScopeEnvelopeBackfillPayloadV1({
    householdId: badHistoricalSignature.row.householdId,
    careProfileId: badHistoricalSignature.row.careProfileId,
    opaqueScopeId: badHistoricalSignature.row.opaqueScopeId,
    keyId: badHistoricalSignature.row.keyId,
    keyEpoch: badHistoricalSignature.row.keyEpoch,
    purpose: badHistoricalSignature.row.purpose,
    recipientDeviceId: badHistoricalSignature.row.recipientDeviceId,
    keyCommitmentSha256: badHistoricalSignature.row.keyCommitmentSha256,
    recipientKeySha256: badHistoricalSignature.row.recipientKeySha256,
    wireSha256: badHistoricalSignature.row.wireSha256,
    historicalActivationSequence:
      badHistoricalSignature.row.historicalActivationSequence,
    historicalActivationSha256:
      badHistoricalSignature.row.historicalActivationSha256,
    currentActiveKeySequence:
      badHistoricalSignature.row.currentActiveKeySequence,
    activeKeyHeadSha256:
      badHistoricalSignature.row.currentActiveKeyHeadSha256,
    currentGrantSequence: badHistoricalSignature.row.currentGrantSequence,
    grantHeadSha256: badHistoricalSignature.row.currentGrantHeadSha256,
    issuerDeviceId: badHistoricalSignature.row.issuerDeviceId,
    issuerCounter: badHistoricalSignature.row.issuerCounter,
    sessionId: badHistoricalSignature.row.sessionId,
    createdAt: badHistoricalSignature.row.createdAt,
    previousActionSha256:
      badHistoricalSignature.action.previousActionSha256,
    issuerSigningKeySha256: sha256Hex(db.prepare(
      "SELECT signing_public_key AS value FROM managed_devices " +
      "WHERE household_id=? AND id=?")
      .get(alpha.h, alpha.d).value),
  });
  badHistoricalSignature.action.actionSha256 = sha256Hex(Buffer.concat([
    Buffer.from(SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1),
    Buffer.from(signedHistoricalPayload),
    badHistoricalSignature.action.signature,
  ]));
  expectHistoricalDeniedAtomically(badHistoricalSignature);
  expectHistoricalDeniedAtomically(historicalCandidate(alpha.d, alpha.key,
    alpha.h, alpha.s, { createdAt: 1n }));
  expectHistoricalDeniedAtomically(historicalCandidate(alpha.d, alpha.key,
    alpha.h, alpha.s, { counterOffset: 1n }));
  expectHistoricalDeniedAtomically(historicalCandidate(alpha.d, alpha.key,
    alpha.h, alpha.s, { previousActionSha256: "00".repeat(32) }));
  const revokedBackfillSession = addSession(alpha, id("7"));
  const revokedBackfillChallenge = candidate.issueWire({
    tokenSha256: revokedBackfillSession.sha256,
    csrfToken: revokedBackfillSession.csrf, deviceId: alpha.d });
  candidate.bindWire({ tokenSha256: revokedBackfillSession.sha256,
    csrfToken: revokedBackfillSession.csrf,
    proof: proof(revokedBackfillChallenge, alpha.key) });
  db.prepare("UPDATE managed_sessions SET revoked_at=? " +
    "WHERE household_id=? AND id=?")
    .run(Math.floor(Date.now() / 1000), alpha.h, id("7"));
  expectHistoricalDeniedAtomically(historicalCandidate(alpha.d, alpha.key,
    alpha.h, id("7")), revokedBackfillSession);
  const beforeHistorical = historicalCounts();
  issueHistorical(historicalCandidate());
  assert.deepEqual(historicalCounts(), {
    actions: beforeHistorical.actions + 1,
    backfills: beforeHistorical.backfills + 1,
  });
  const historicalRead = () => readAccountScopedScopeEnvelopeCandidateV2(db, {
    tokenSha256: historicalRecipientSession.sha256, careProfileId: profileId,
    opaqueScopeId: historicalScopeId, keyId: historicalKeyId, keyEpoch: 1 });
  assert.equal(historicalRead().kind, "historical-backfill");
  assert.equal(historicalRead().row.recipientDeviceId, secondDevice);
  assert.throws(() => readAccountScopedScopeEnvelopeCandidateV2(db, {
    tokenSha256: alpha.session.sha256, careProfileId: profileId,
    opaqueScopeId: historicalScopeId, keyId: historicalKeyId, keyEpoch: 1 }),
  (error) => error?.name === "ManagedScopeEnvelopeReadDenied");
  assert.throws(() => readAccountScopedScopeEnvelopeCandidateV2(db, {
    tokenSha256: beta.session.sha256, careProfileId: profileId,
    opaqueScopeId: historicalScopeId, keyId: historicalKeyId, keyEpoch: 1 }),
  (error) => error?.name === "ManagedScopeEnvelopeReadDenied");
  // The signed action insert happens first. A duplicate backfill must roll it
  // back along with the rejected row, not consume a device action counter.
  expectHistoricalDeniedAtomically(historicalCandidate());
  const revokeHistoricalGrant = appendStructuralAction("grant");
  db.prepare("INSERT INTO managed_grant_events " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,2,?,?,0,?,?,?)")
    .run(alpha.h, profileId, historicalScopeId, secondDevice,
      historicalGrant.payloadHash, revokeHistoricalGrant.payloadHash,
      alpha.d, revokeHistoricalGrant.counter, revokeHistoricalGrant.createdAt);
  assert.throws(historicalRead,
    (error) => error?.name === "ManagedScopeEnvelopeReadDenied");
  expectHistoricalDeniedAtomically(historicalCandidate());

  const revokedIssuerSession = addSession(alpha, id("2"));
  const revokedIssuerChallenge = candidate.issueWire({
    tokenSha256: revokedIssuerSession.sha256,
    csrfToken: revokedIssuerSession.csrf, deviceId: alpha.d });
  candidate.bindWire({ tokenSha256: revokedIssuerSession.sha256,
    csrfToken: revokedIssuerSession.csrf,
    proof: proof(revokedIssuerChallenge, alpha.key) });
  db.prepare("UPDATE managed_sessions SET revoked_at=? " +
    "WHERE household_id=? AND id=?").run(now, alpha.h, id("2"));
  expectEnvelopeDeniedAtomically(envelopeCandidate(alpha.d, alpha.key,
    secondDevice, id("2")), revokedIssuerSession);

  const freshSession = addSession(alpha, id("d"));
  const freshInput = { tokenSha256: freshSession.sha256,
    csrfToken: freshSession.csrf, deviceId: secondDevice };
  const revokedChallenge = candidate.issueWire(freshInput);
  db.prepare("UPDATE managed_devices SET state='revoked', revoked_at=? " +
    "WHERE household_id=? AND id=?").run(now, alpha.h, secondDevice);
  expectEnvelopeDeniedAtomically(envelopeCandidate(alpha.d, alpha.key,
    secondDevice));
  expectDenied(() => candidate.bindWire({ tokenSha256: freshSession.sha256,
    csrfToken: freshSession.csrf, proof: proof(revokedChallenge, secondKey) }));

  const capSession = addSession(alpha, id("e"));
  const capInput = { tokenSha256: capSession.sha256,
    csrfToken: capSession.csrf, deviceId: alpha.d };
  for (let i = 0; i < 16; i++) candidate.issueWire(capInput);
  expectDenied(() => candidate.issueWire(capInput));
  const httpSession = addSession(beta, id("0"));
  const alphaHttpSession = addSession(alpha, id("1"));
  const httpEmail = "fictional-http-owner@example.invalid";
  const app = express();
  let httpRouter;
  let authRouter;
  app.use("/api/managed/auth", (request, response, next) =>
    authRouter(request, response, next));
  app.use("/api/managed/device", (request, response, next) =>
    httpRouter(request, response, next));
  httpServer = await new Promise((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const httpAddress = httpServer.address();
  assert.ok(httpAddress && typeof httpAddress !== "string");
  const httpOrigin = `http://127.0.0.1:${httpAddress.port}`;
  authRouter = createManagedAuthRouter({ expectedOrigin: httpOrigin,
    identity, credentialBucketKey: Buffer.alloc(32, 7),
    rateLimit: () => true });
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
  const signupBody = { email: httpEmail, password: registrationPassword };
  const httpSignup = async (body) => fetch(`${httpOrigin}/api/managed/auth/signup`, {
    method: "POST", headers: { "content-type": "application/json",
      origin: httpOrigin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  const signupResponse = await httpSignup(signupBody);
  assert.equal(signupResponse.status, 202);
  assert.deepEqual(await signupResponse.json(), { accepted: true });
  assert.equal(signupResponse.headers.get("set-cookie"), null);
  const httpOwner = db.prepare("SELECT a.id AS accountId, " +
    "m.household_id AS householdId, a.state AS accountState, " +
    "m.state AS memberState, f.state AS familyState " +
    "FROM managed_accounts a " +
    "JOIN managed_memberships m ON m.account_id=a.id " +
    "JOIN managed_families f ON f.id=m.household_id " +
    "WHERE a.login_email=?").get(httpEmail);
  assert.deepEqual([httpOwner.accountState, httpOwner.memberState,
    httpOwner.familyState], ["pending", "pending", "frozen"]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_sessions " +
    "WHERE account_id=?").get(httpOwner.accountId).n, 0);
  await assert.rejects(identity.login({ email: httpEmail,
    password: registrationPassword, householdId: httpOwner.householdId }),
  (error) => error?.name === "ManagedIdentityDenied");
  const repeatSignup = await httpSignup({ ...signupBody,
    email: httpEmail.toUpperCase() });
  assert.equal(repeatSignup.status, 202);
  assert.deepEqual(await repeatSignup.json(), { accepted: true });
  assert.equal(repeatSignup.headers.get("set-cookie"), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_accounts " +
    "WHERE login_email=?").get(httpEmail).n, 1);
  // Test-only direct SQL simulates a future one-use email verification
  // ceremony; the v10 router must never expose this state transition.
  const httpNow = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE managed_accounts SET state='active', " +
    "email_verified_at=?, auth_version=2 WHERE id=?")
    .run(httpNow, httpOwner.accountId);
  db.prepare("UPDATE managed_memberships SET state='active', " +
    "auth_version=2 WHERE household_id=? AND account_id=?")
    .run(httpOwner.householdId, httpOwner.accountId);
  db.prepare("UPDATE managed_families SET state='active' WHERE id=?")
    .run(httpOwner.householdId);
  const httpLogin = await fetch(`${httpOrigin}/api/managed/auth/login`, {
    method: "POST", headers: { "content-type": "application/json",
      origin: httpOrigin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ email: httpEmail, password: registrationPassword,
      householdId: httpOwner.householdId }),
  });
  assert.equal(httpLogin.status, 200);
  const httpLoginCookie = httpLogin.headers.get("set-cookie").split(";")[0];
  assert.ok(httpLoginCookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  const httpLoginView = await httpLogin.json();
  assert.equal(httpLoginView.accountId, httpOwner.accountId);
  assert.equal(JSON.stringify(httpLoginView).includes(httpLoginCookie.slice(
    SESSION_COOKIE_NAME.length + 1)), false);
  const httpSessionView = await fetch(`${httpOrigin}/api/managed/auth/session`, {
    headers: { cookie: httpLoginCookie, "sec-fetch-site": "same-origin" },
  });
  assert.equal(httpSessionView.status, 200);
  assert.equal((await httpSessionView.json()).accountId, httpOwner.accountId);
  assert.equal((await fetch(`${httpOrigin}/api/managed/auth/logout`, {
    method: "POST", headers: { origin: httpOrigin,
      "sec-fetch-site": "same-origin", cookie: httpLoginCookie,
      "x-csrf-token": "wrong-fictional-csrf" },
  })).status, 403);
  assert.equal((await fetch(`${httpOrigin}/api/managed/auth/session`, {
    headers: { cookie: httpLoginCookie,
      "sec-fetch-site": "same-origin" },
  })).status, 200);
  const httpLogout = await fetch(`${httpOrigin}/api/managed/auth/logout`, {
    method: "POST", headers: { origin: httpOrigin,
      "sec-fetch-site": "same-origin", cookie: httpLoginCookie,
      "x-csrf-token": httpLoginView.csrfToken },
  });
  assert.equal(httpLogout.status, 204);
  assert.equal((await fetch(`${httpOrigin}/api/managed/auth/session`, {
    headers: { cookie: httpLoginCookie,
      "sec-fetch-site": "same-origin" },
  })).status, 401);
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
  // A previously issued ciphertext envelope must become unreadable on the
  // next request after its current read grant is removed. This does not erase
  // key material already downloaded by a recipient.
  const priorGrantAction = db.prepare("SELECT counter, action_sha256 AS hash " +
    "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
    "ORDER BY counter DESC LIMIT 1").get(alpha.h, alpha.d);
  const priorGrantHead = db.prepare("SELECT sequence, head_sha256 AS hash " +
    "FROM managed_grant_heads WHERE household_id=? AND profile_id=? " +
    "AND scope_id=? AND subject_device_id=?")
    .get(alpha.h, profileId, scopeId, alpha.d);
  const revokeGrantAt = Math.floor(Date.now() / 1000);
  const revokeGrantPayload = randomBytes(32);
  db.prepare("INSERT INTO managed_signed_actions " +
    "(household_id,device_id,counter,action_kind,payload_sha256," +
    "previous_action_sha256,action_sha256,signature,created_at) " +
    "VALUES (?,?,?,'grant',?,?,?,?,?)")
    .run(alpha.h, alpha.d, priorGrantAction.counter + 1,
      revokeGrantPayload, priorGrantAction.hash, randomBytes(32),
      randomBytes(64), revokeGrantAt);
  db.prepare("INSERT INTO managed_grant_events " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)")
    .run(alpha.h, profileId, scopeId, alpha.d,
      priorGrantHead.sequence + 1, priorGrantHead.hash, revokeGrantPayload,
      alpha.d, priorGrantAction.counter + 1, revokeGrantAt);
  assert.throws(readEnvelope,
    (error) => error?.name === "ManagedScopeEnvelopeReadDenied");
  assert.equal(await ledger.readReceipt(firstReceiptInput), null);
  db.prepare("UPDATE managed_sessions SET revoked_at=? " +
    "WHERE household_id=? AND id=?").run(revokeGrantAt, alpha.h, alpha.s);
  await assert.rejects(ledger.publishVerified({ intent: stagedSecond,
    tokenSha256: alpha.session.sha256, csrfToken: alpha.session.csrf,
    wireSha256: digest(secondWire), wireBytes: secondWire.byteLength,
    chunks: [{ index: 0, iv: Buffer.alloc(12, 3),
      storageObjectId: id("7"), ciphertextSha256: digest(firstCiphertext),
      ciphertextBytes: 16 }], signal: uploadSignal }),
  ManagedVaultUploadSessionError);
  await assert.rejects(ledger.readReceipt(firstReceiptInput),
    ManagedVaultUploadSessionError);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_committed_blobs " +
    "WHERE household_id=? AND intent_id=?").get(alpha.h, id("f")).n, 0);
  ledger.close(); // Borrowed connection must remain open and in the outer txn.
  assert.equal(db.inTransaction, true);
  assert.equal(db.prepare("SELECT 1 AS alive").get().alive, 1);
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
  console.log("PASS: fictional pending signup, verified auth, two-family binding, bound day intent, ordinary/historical signed envelopes, one-chunk ledger/receipt and two-chunk rollback; cross-family, nonce replay, quota and grant/device/session revocation denial");
} finally {
  if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
  // Preserve the approved empty database; never delete it or any records.
  db.exec("ROLLBACK");
  db.close();
}
