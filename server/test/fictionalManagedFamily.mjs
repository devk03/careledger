import { randomBytes } from "node:crypto";

import { issueCsrfToken, issueSessionToken } from
  "../dist/auth/cookieSession.js";

const id = (byte) => byte.repeat(32);

// Structural invented fixture only. Signatures are not real enrollment proofs.
export function seedFictionalManagedFamily(db, byte, accountByte, now,
  { intentByte = "8", blobByte = "9", plaintextBytes = 0,
    enrolledSigningPublicKey } = {}) {
  const householdId = id(byte);
  const accountId = id(accountByte);
  const sessionId = id("3");
  const deviceId = id("4");
  const profileId = id("5");
  const scopeId = id("6");
  const keyId = id("7");
  const intentId = id(intentByte);
  const blobId = id(blobByte);
  const token = issueSessionToken();
  const csrfSecret = randomBytes(32);
  const encryptionPublicKey = randomBytes(32);
  const signingPublicKey = enrolledSigningPublicKey ?? randomBytes(32);
  if (!Buffer.isBuffer(signingPublicKey) || signingPublicKey.length !== 32)
    throw new Error("Invalid fictional signing key");
  const enrollmentId = id("a");
  const bindingChallengeId = id("b");
  const keyCommitment = randomBytes(32);
  db.prepare("INSERT INTO managed_families VALUES (?,'active',?)")
    .run(householdId, now);
  db.prepare("INSERT INTO managed_accounts " +
    "(id,login_email,password_hash,state,email_verified_at,created_at) " +
    "VALUES (?,?,?,'active',?,?)")
    .run(accountId, `fictional-race-${byte}@example.invalid`,
      "fictional-not-a-real-password-hash-placeholder-000000", now, now);
  db.prepare("INSERT INTO managed_memberships " +
    "(household_id,account_id,member_kind,role,state,created_at) " +
    "VALUES (?,?,'adult','owner','active',?)")
    .run(householdId, accountId, now);
  db.prepare("INSERT INTO managed_sessions " +
    "(household_id,id,account_id,token_sha256,csrf_secret," +
    "account_auth_version,membership_auth_version,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,1,?,?)")
    .run(householdId, sessionId, accountId,
      Buffer.from(token.sha256, "hex"), csrfSecret, now, now + 3600);
  db.prepare("INSERT INTO managed_enrollment_challenges " +
    "(household_id,id,account_id,session_id,challenge_sha256," +
    "encryption_public_key,signing_public_key,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)")
    .run(householdId, enrollmentId, accountId, sessionId, randomBytes(32),
      encryptionPublicKey, signingPublicKey, now, now + 600);
  db.prepare("INSERT INTO managed_devices " +
    "(household_id,id,account_id,enrollment_challenge_id,state," +
    "encryption_public_key,signing_public_key,created_at) " +
    "VALUES (?,?,?,?,'pending',?,?,?)")
    .run(householdId, deviceId, accountId, enrollmentId,
      encryptionPublicKey, signingPublicKey, now);
  db.prepare("UPDATE managed_enrollment_challenges SET consumed_at=?, " +
    "proof_signature=? WHERE household_id=? AND id=?")
    .run(now, randomBytes(64), householdId, enrollmentId);
  db.prepare("UPDATE managed_devices SET state='active', activated_at=? " +
    "WHERE household_id=? AND id=?").run(now, householdId, deviceId);
  db.prepare("INSERT INTO managed_session_device_challenges " +
    "(household_id,id,account_id,session_id,device_id,nonce_sha256," +
    "audience_sha256,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?)")
    .run(householdId, bindingChallengeId, accountId, sessionId, deviceId,
      randomBytes(32), randomBytes(32), now, now + 300);
  db.prepare("UPDATE managed_session_device_challenges SET consumed_at=?, " +
    "proof_signature=? WHERE household_id=? AND id=?")
    .run(now, randomBytes(64), householdId, bindingChallengeId);
  db.prepare("INSERT INTO managed_session_device_bindings " +
    "(household_id,session_id,account_id,device_id,challenge_id,bound_at) " +
    "VALUES (?,?,?,?,?,?)")
    .run(householdId, sessionId, accountId, deviceId, bindingChallengeId, now);
  db.prepare("INSERT INTO managed_profiles " +
    "(household_id,id,state,created_by_account_id,created_at) " +
    "VALUES (?,?,'active',?,?)")
    .run(householdId, profileId, accountId, now);
  db.prepare("INSERT INTO managed_scopes " +
    "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
    "VALUES (?,?,?,'day','active',?,?)")
    .run(householdId, profileId, scopeId, deviceId, now);
  let counter = 0;
  let predecessor = null;
  const signedAction = (kind) => {
    counter += 1;
    const payloadSha256 = randomBytes(32);
    const actionSha256 = randomBytes(32);
    db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)")
      .run(householdId, deviceId, counter, kind, payloadSha256,
        predecessor, actionSha256, randomBytes(64), now);
    predecessor = actionSha256;
    return { counter, payloadSha256 };
  };
  // The key/grant signatures are structural invented fixtures; the real
  // ledger still rechecks their resulting relational authority and binding.
  const registration = signedAction("key");
  db.prepare("INSERT INTO managed_key_identities " +
    "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
    "key_commitment,signed_payload_sha256,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,'day',?,?,?,?,?)")
    .run(householdId, profileId, scopeId, keyId, keyCommitment,
      registration.payloadSha256, deviceId, registration.counter, now);
  const activation = signedAction("key");
  db.prepare("INSERT INTO managed_active_key_events " +
    "(household_id,profile_id,scope_id,sequence,previous_sha256," +
    "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
    "key_commitment,registration_sha256,issuer_device_id,session_id," +
    "issuer_counter,created_at) " +
    "VALUES (?,?,?,1,NULL,NULL,NULL,?,?,1,'day',?,?,?,?,?,?)")
    .run(householdId, profileId, scopeId, activation.payloadSha256, keyId,
      keyCommitment, registration.payloadSha256, deviceId, sessionId,
      activation.counter, now);
  db.prepare("INSERT INTO managed_grant_heads " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "head_sha256,capability_mask,updated_at) VALUES (?,?,?,?,0,NULL,0,?)")
    .run(householdId, profileId, scopeId, deviceId, now);
  const grant = signedAction("grant");
  db.prepare("INSERT INTO managed_grant_events " +
    "(household_id,profile_id,scope_id,subject_device_id,sequence," +
    "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
    "issuer_counter,created_at) VALUES (?,?,?,?,1,NULL,?,3,?,?,?)")
    .run(householdId, profileId, scopeId, deviceId, grant.payloadSha256,
      deviceId, grant.counter, now);
  db.prepare("INSERT INTO managed_upload_intents " +
    "(household_id,id,profile_id,scope_id,key_id,epoch,purpose," +
    "wire_version,blob_id,writer_device_id,session_id,plaintext_bytes," +
    "chunk_count,created_at,expires_at) " +
    "VALUES (?,?,?,?,?,1,'day',2,?,?,?,?,1,?,?)")
    .run(householdId, intentId, profileId, scopeId, keyId, blobId,
      deviceId, sessionId, plaintextBytes, now, now + 600);
  return { householdId, accountId, profileId, scopeId, keyId, blobId, deviceId,
    sessionToken: token.plaintext, tokenSha256: token.sha256,
    csrfToken: issueCsrfToken(sessionId, csrfSecret), intentId,
    session: { scope: { householdId, userId: accountId },
      sessionId, csrfSecret, expiresAt: now + 3600 } };
}
