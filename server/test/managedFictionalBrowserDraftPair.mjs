import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import express from "express";

import { SESSION_COOKIE_NAME, sessionSetCookie } from
  "../dist/auth/cookieSession.js";
import { createManagedCiphertextAdmissionRouter } from
  "../dist/managed/ciphertextAdmission.js";
import { readCiphertextChunk } from
  "../dist/managed/ciphertextObjectStore.js";
import { createManagedDraftPairRouter } from
  "../dist/managed/managedDraftPairRouter.js";
import { createManagedPendingDraftPairRouter } from
  "../dist/managed/managedPendingDraftPairRouter.js";
import { assertManagedSchema } from
  "../dist/managed/managedSchemaGuard.js";
import { createNonDayDraftUploadComposition } from
  "../dist/managed/nonDayDraftUploadComposition.js";
import { SqliteDraftPairReservation } from
  "../dist/managed/sqliteDraftPairReservation.js";
import { SqliteManagedSessions } from
  "../dist/managed/sqliteManagedSessions.js";
import { submitPendingDraftPair } from
  "../dist/managed/sqlitePendingDraftPairWriter.js";
import { createManagedUploadReceiptRouter } from
  "../dist/managed/uploadReceipt.js";
import { seedFictionalManagedFamily } from "./fictionalManagedFamily.mjs";

// This executable never applies a migration or opens the source for writing.
// Browser, API, DB and object storage exist only inside this fictional run.
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
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256(readFileSync(sourcePath)), EMPTY_SHA256);

const requireWeb = createRequire(new URL("../../web/package.json",
  import.meta.url));
const { createServer: createViteServer } = requireWeb("vite");
const { chromium } = requireWeb("playwright");
const webRoot = fileURLToPath(new URL("../../web/", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "adeno-fictional-browser-pair-"));
const dbPath = join(root, "managed.sqlite3");
const objectRoot = await mkdtemp(join(root, "objects-"));
await copyFile(sourcePath, dbPath);
await chmod(dbPath, 0o600);
const db = new Database(dbPath, { fileMustExist: true, timeout: 5_000 });
let server;
let vite;
let browser;
try {
  db.pragma("foreign_keys = ON");
  db.pragma("trusted_schema = OFF");
  db.pragma("synchronous = EXTRA");
  assertManagedSchema(db);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_families").get().n,
    0);
  const reservation = new SqliteDraftPairReservation(db, 1024 * 1024,
    2 * 1024 * 1024);
  const composition = createNonDayDraftUploadComposition({ connection: db,
    objectRoot, maxStoredBytesPerFamily: 1024 * 1024,
    maxGlobalStoredBytes: 2 * 1024 * 1024 });
  const sessions = new SqliteManagedSessions(db);
  const app = express();
  server = await new Promise(resolve => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const fictionalLoginTokens = new Map();
  app.post("/__fictional-login/:family", (request, response) => {
    const token = fictionalLoginTokens.get(request.params.family);
    if (request.get("origin") !== base || !token) {
      response.status(404).end();
      return;
    }
    fictionalLoginTokens.delete(request.params.family);
    response.setHeader("Set-Cookie", sessionSetCookie(token));
    response.setHeader("Cache-Control", "no-store");
    response.status(204).end();
  });
  app.use("/api/managed/draft-pairs", createManagedDraftPairRouter({
    expectedOrigin: base, service: reservation, rateLimit: () => true,
  }));
  app.use("/api/managed/pending-pairs", createManagedPendingDraftPairRouter({
    expectedOrigin: base,
    submit: submission => submitPendingDraftPair(db, submission),
    rateLimit: () => true,
  }));
  app.use(createManagedCiphertextAdmissionRouter({ sessions,
    expectedOrigin: base, store: composition.store }));
  app.use(createManagedUploadReceiptRouter({ expectedOrigin: base,
    reader: composition.receipts }));
  vite = await createViteServer({ root: webRoot,
    configFile: join(webRoot, "vite.config.ts"), mode: "ui-preview",
    server: { middlewareMode: true, hmr: false }, appType: "spa" });
  app.use(vite.middlewares);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${base}/design-system`);
  const publicKeys = await page.evaluate(async () => {
    const { generateProposedDeviceKeys, proposedDevicePublicKeys } =
      await import("/src/crypto/deviceEnrollmentProof.ts");
    const keys = await generateProposedDeviceKeys();
    window.__fictionalPair = { keys };
    return proposedDevicePublicKeys(keys);
  });
  const now = Math.floor(Date.now() / 1000);
  const [alpha, beta] = db.transaction(() => [
    seedFictionalManagedFamily(db, "1", "2", now, {
      enrolledEncryptionPublicKey: Buffer.from(
        publicKeys.encryptionPublicKeyHex, "hex"),
      enrolledSigningPublicKey: Buffer.from(
        publicKeys.signingPublicKeyHex, "hex"),
    }),
    seedFictionalManagedFamily(db, "6", "7", now,
      { intentByte: "c", blobByte: "d" }),
  ]).immediate();
  fictionalLoginTokens.set("alpha", alpha.sessionToken);
  fictionalLoginTokens.set("beta", beta.sessionToken);
  assert.equal(await page.evaluate(async () => (await fetch(
    "/__fictional-login/alpha", { method: "POST",
      credentials: "same-origin" })).status), 204);
  const storedCookie = (await context.cookies())
    .find(cookie => cookie.name === SESSION_COOKIE_NAME);
  assert.ok(storedCookie);
  assert.equal(storedCookie.secure, true);
  assert.equal(storedCookie.httpOnly, true);
  assert.equal(storedCookie.sameSite, "Strict");
  assert.equal(storedCookie.path, "/");
  const cookieSeen = await page.evaluate(name =>
    document.cookie.includes(name), SESSION_COOKIE_NAME);
  assert.equal(cookieSeen, false);
  const scopeId = randomBytes(16).toString("hex");
  const keyId = randomBytes(16).toString("hex");
  const commitment = await page.evaluate(async identity => {
    const { createScopeKeyEnvelopesV2 } = await import(
      "/src/crypto/scopeKeyEnvelopeV2.ts");
    const state = window.__fictionalPair;
    const created = await createScopeKeyEnvelopesV2({
      householdId: identity.householdId,
      careProfileId: identity.profileId,
      opaqueScopeId: identity.scopeId,
      keyId: identity.keyId, keyEpoch: 1, purpose: "draft",
    }, [{ deviceId: identity.deviceId,
      publicKey: state.keys.encryptionKeys.publicKey }]);
    state.draft = created;
    return created.keyCommitmentSha256;
  }, { householdId: alpha.householdId, profileId: alpha.profileId,
    scopeId, keyId, deviceId: alpha.deviceId });
  seedDraftScope(db, alpha, now, { scopeId, keyId,
    commitment: Buffer.from(commitment, "hex") });
  const deniedBeforeUpload = await page.evaluate(async input => {
    const body = JSON.stringify({ reservationId: "f".repeat(32),
      profileId: input.profileId, scopeId: input.scopeId,
      keyId: input.keyId, epoch: 1 });
    const post = (credentials, csrf) => fetch(
      "/api/managed/draft-pairs/reserve", { method: "POST", credentials,
        headers: { "content-type": "application/json",
          "x-csrf-token": csrf }, body });
    return { wrongCsrf: (await post("same-origin", "wrong")).status,
      missingCookie: (await post("omit", input.csrfToken)).status };
  }, { profileId: alpha.profileId, scopeId, keyId,
    csrfToken: alpha.csrfToken });
  assert.deepEqual(deniedBeforeUpload, { wrongCsrf: 404,
    missingCookie: 401 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_draft_reservations")
    .get().n, 0);

  const marker = "FICTIONAL_BROWSER_DRAFT_NOT_A_REAL_PERSON";
  const careDay = "2030-01-02";
  const markers = [marker, careDay, "Fictional caregiver"];
  const forbidden = markers.flatMap(value => {
    const bytes = Buffer.from(value);
    return [value, encodeURIComponent(value), bytes.toString("base64"),
      bytes.toString("base64url"), bytes.toString("hex")];
  }).map(value => Buffer.from(value));
  let leaked = false;
  let wrongBrowserOrigin = false;
  let uploadPosts = 0;
  let responseLost = false;
  page.on("request", request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return;
    const headers = request.headers();
    if (request.method() === "POST" && headers.origin !== base)
      wrongBrowserOrigin = true;
    const visible = [Buffer.from(request.url()),
      Buffer.from(JSON.stringify(headers)), request.postDataBuffer()]
      .filter(Boolean);
    if (visible.some(bytes => forbidden.some(value => bytes.includes(value))))
      leaked = true;
  });
  await page.route("**/api/v3/vault/intents/**", async route => {
    if (route.request().url().endsWith("/receipt")) {
      await route.continue();
      return;
    }
    uploadPosts += 1;
    if (!responseLost) {
      responseLost = true;
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const uploaded = await page.evaluate(async input => {
    const { decodeManagedVaultBlobV2 } = await import(
      "/src/crypto/managedVaultWireV2.ts");
    const { prepareLocalEncryptedDraft } = await import(
      "/src/managed/intakeDraft.ts");
    const { savePreparedDraftUpload, attemptDraftUploadRole } = await import(
      "/src/managed/draftUploadJournal.ts");
    const state = window.__fictionalPair;
    const csrfToken = input.csrfToken;
    const post = async (action, body) => {
      const response = await fetch(`/api/managed/draft-pairs/${action}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        redirect: "error", headers: { "content-type": "application/json",
          "x-csrf-token": csrfToken }, body: JSON.stringify(body),
      });
      if (response.status !== 201) throw new Error(`Draft ${action} denied`);
      return response.json();
    };
    const hex = bytes => [...bytes]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const reservationId = hex(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem("adeno:fictional-test:reservation", reservationId);
    if (localStorage.getItem("adeno:fictional-test:reservation") !==
      reservationId) throw new Error("Reservation was not retained");
    const ids = await post("reserve", { reservationId,
      profileId: input.profileId, scopeId: input.scopeId,
      keyId: input.keyId, epoch: 1 });
    const prepared = await prepareLocalEncryptedDraft({
      identity: { householdId: input.householdId,
        careProfileId: input.profileId, opaqueDraftId: input.scopeId,
        keyEpoch: 1 }, key: state.draft.key,
      reservedBlobIds: { content: ids.contentBlobId,
        metadata: ids.metadataBlobId },
      clientSelectedAt: "2030-01-03T12:00:00.000Z",
      candidateCareDays: [input.careDay], kind: "family_note",
      body: input.marker, authorLabel: "Fictional caregiver",
    });
    const content = decodeManagedVaultBlobV2(prepared.contentWire);
    const metadata = decodeManagedVaultBlobV2(prepared.metadataWire);
    await post("bind-intents", { reservationId,
      content: { objectId: prepared.contentObjectId,
        plaintextBytes: content.plaintextSize },
      metadata: { objectId: prepared.metadataObjectId,
        plaintextBytes: metadata.plaintextSize } });
    await post("open-leases", { reservationId });
    const tuple = { householdId: input.householdId,
      accountId: input.accountId, sessionId: input.sessionId,
      reservationId };
    const saved = await savePreparedDraftUpload({ ...tuple,
      contentIntentId: ids.contentIntentId,
      metadataIntentId: ids.metadataIntentId,
      contentBlobId: ids.contentBlobId,
      metadataBlobId: ids.metadataBlobId,
      contentWire: prepared.contentWire,
      metadataWire: prepared.metadataWire });
    state.prepared = prepared;
    state.ids = ids;
    const contentStatus = await attemptDraftUploadRole({ tuple,
      role: "content", wire: prepared.contentWire, csrfToken });
    const metadataStatus = await attemptDraftUploadRole({ tuple,
      role: "metadata", wire: prepared.metadataWire, csrfToken });
    return { ids, tuple, contentStatus, metadataStatus,
      wireDigests: { content: saved.contentWireSha256,
        metadata: saved.metadataWireSha256 },
      wireBytes: { content: saved.contentWireBytes,
        metadata: saved.metadataWireBytes } };
  }, { householdId: alpha.householdId, accountId: alpha.accountId,
    sessionId: alpha.session.sessionId, profileId: alpha.profileId,
    scopeId, keyId, csrfToken: alpha.csrfToken, careDay, marker });
  assert.equal(uploaded.contentStatus, "committed");
  assert.equal(uploaded.metadataStatus, "committed");
  assert.equal(responseLost, true);
  assert.equal(uploadPosts, 2);
  assert.equal(leaked, false);
  assert.equal(wrongBrowserOrigin, false);

  const keyRow = db.prepare("SELECT key_commitment AS digest FROM " +
    "managed_key_identities WHERE household_id=? AND key_id=? AND epoch=1")
    .get(alpha.householdId, keyId);
  assert.equal(keyRow.digest.toString("hex"), commitment);
  const active = db.prepare("SELECT head_sha256 AS digest FROM " +
    "managed_current_scope_keys WHERE household_id=? AND profile_id=? " +
    "AND scope_id=?").get(alpha.householdId, alpha.profileId, scopeId);
  const grant = db.prepare("SELECT head_sha256 AS digest FROM " +
    "managed_grant_heads WHERE household_id=? AND profile_id=? " +
    "AND scope_id=? AND subject_device_id=?")
    .get(alpha.householdId, alpha.profileId, scopeId, alpha.deviceId);
  const prior = db.prepare("SELECT counter, action_sha256 AS digest FROM " +
    "managed_signed_actions WHERE household_id=? AND device_id=? " +
    "ORDER BY counter DESC LIMIT 1")
    .get(alpha.householdId, alpha.deviceId);
  const signed = await page.evaluate(async input => {
    const { signPendingDraftPair } = await import(
      "/src/crypto/signedPendingDraftPair.ts");
    const state = window.__fictionalPair;
    const claims = { householdId: input.householdId,
      careProfileId: input.profileId,
      opaqueDraftScopeId: input.scopeId, keyId: input.keyId,
      reservationId: state.ids.reservationId,
      contentIntentId: state.ids.contentIntentId,
      metadataIntentId: state.ids.metadataIntentId,
      contentBlobId: state.ids.contentBlobId,
      metadataBlobId: state.ids.metadataBlobId,
      contentObjectId: state.prepared.contentObjectId,
      metadataObjectId: state.prepared.metadataObjectId,
      authorDeviceId: input.deviceId, sessionId: input.sessionId,
      keyEpoch: 1, authorCounter: BigInt(input.authorCounter),
      keyCommitmentSha256: input.keyCommitmentSha256,
      activeKeyHeadSha256: input.activeKeyHeadSha256,
      grantHeadSha256: input.grantHeadSha256,
      previousActionSha256: input.previousActionSha256 };
    const proof = await signPendingDraftPair({ claims,
      contentWire: state.prepared.contentWire,
      metadataWire: state.prepared.metadataWire,
      draftKeyEnvelope: state.draft.envelopes[0],
      recipientEncryptionKeys: state.keys.encryptionKeys,
      signingKeys: state.keys.signingKeys,
      csrfToken: input.csrfToken });
    const body = { context: { ...proof.context,
      authorCounter: proof.context.authorCounter.toString(),
      pairedAt: proof.context.pairedAt.toString() },
      signature: btoa(String.fromCharCode(...proof.signature)) };
    const post = async () => {
      const response = await fetch("/api/managed/pending-pairs/submit", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        redirect: "error", headers: { "content-type": "application/json",
          "x-csrf-token": input.csrfToken }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    return { first: await post(), retry: await post(),
      payloadSha256: proof.payloadSha256 };
  }, { householdId: alpha.householdId, profileId: alpha.profileId,
    scopeId, keyId, deviceId: alpha.deviceId,
    sessionId: alpha.session.sessionId, authorCounter: prior.counter + 1,
    keyCommitmentSha256: commitment,
    activeKeyHeadSha256: active.digest.toString("hex"),
    grantHeadSha256: grant.digest.toString("hex"),
    previousActionSha256: prior.digest.toString("hex"),
    csrfToken: alpha.csrfToken });
  assert.equal(signed.first.status, 201);
  assert.equal(signed.retry.status, 201);
  assert.deepEqual(signed.first.body, signed.retry.body);
  assert.equal(signed.first.body.status, "pending");
  assert.equal(signed.first.body.pairSha256, signed.payloadSha256);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_pending_draft_pairs")
    .get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM managed_day_revisions")
    .get().n, 0);

  const betaContext = await browser.newContext();
  const betaPage = await betaContext.newPage();
  await betaPage.goto(`${base}/design-system`);
  assert.equal(await betaPage.evaluate(async () => (await fetch(
    "/__fictional-login/beta", { method: "POST",
      credentials: "same-origin" })).status), 204);
  const betaReceiptStatus = await betaPage.evaluate(async input => {
    const response = await fetch(`/api/v3/vault/intents/` +
      `${input.intentId}/blobs/${input.blobId}/receipt`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "x-csrf-token": input.csrfToken },
    });
    return response.status;
  }, { intentId: uploaded.ids.contentIntentId,
    blobId: uploaded.ids.contentBlobId, csrfToken: beta.csrfToken });
  assert.equal(betaReceiptStatus, 404);
  await betaContext.close();

  await page.reload();
  const reconciled = await page.evaluate(async input => {
    const { reconcileDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    return reconcileDraftUpload({ tuple: input.tuple,
      csrfToken: input.csrfToken });
  }, { tuple: uploaded.tuple, csrfToken: alpha.csrfToken });
  assert.deepEqual(reconciled, { content: "committed",
    metadata: "committed" });
  assert.equal(uploadPosts, 2);
  assert.equal(leaked, false);
  assert.equal(wrongBrowserOrigin, false);

  const committed = db.prepare("SELECT role, wire_sha256 AS digest, " +
    "wire_bytes AS bytes FROM managed_non_day_committed_blobs " +
    "WHERE household_id=? AND intent_id IN (?,?)")
    .all(alpha.householdId, uploaded.ids.contentIntentId,
      uploaded.ids.metadataIntentId);
  assert.equal(committed.length, 2);
  for (const row of committed) {
    assert.ok(row.role === "content" || row.role === "metadata");
    assert.equal(row.digest.toString("hex"), uploaded.wireDigests[row.role]);
    assert.equal(row.bytes, uploaded.wireBytes[row.role]);
  }

  const rows = db.prepare("SELECT household_id AS householdId, " +
    "storage_object_id AS objectId, ciphertext_sha256 AS digest, " +
    "ciphertext_bytes AS bytes FROM managed_non_day_blob_chunks")
    .all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const disk = await readCiphertextChunk(objectRoot, row.householdId,
      row.objectId, row.digest.toString("hex"), row.bytes);
    for (const value of forbidden)
      assert.equal(disk.includes(value), false);
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`,
    `${dbPath}-journal`]) {
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const value of forbidden)
      assert.equal(bytes.includes(value), false);
  }
  assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(existsSync(`${sourcePath}-wal`), false);
  assert.equal(existsSync(`${sourcePath}-shm`), false);
  assert.equal(sha256(readFileSync(sourcePath)), EMPTY_SHA256);
  process.stdout.write("PASS: fictional Chromium encrypted note -> real " +
    "test-only HTTP receipts -> browser signature -> pending pair; " +
    `source unchanged. Copy retained at ${dbPath}\n`);
} finally {
  if (browser) await browser.close();
  if (vite) await vite.close();
  if (server) await new Promise(resolve => server.close(resolve));
  db.close();
}

function seedDraftScope(db, family, now, input) {
  const { scopeId, keyId, commitment } = input;
  const latest = db.prepare("SELECT counter, action_sha256 AS digest " +
    "FROM managed_signed_actions WHERE household_id=? AND device_id=? " +
    "ORDER BY counter DESC LIMIT 1")
    .get(family.householdId, family.deviceId);
  let counter = latest.counter;
  let predecessor = latest.digest;
  const action = kind => {
    counter += 1;
    const digest = randomBytes(32);
    const payload = randomBytes(32);
    db.prepare("INSERT INTO managed_signed_actions " +
      "(household_id,device_id,counter,action_kind,payload_sha256," +
      "previous_action_sha256,action_sha256,signature,created_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?)")
      .run(family.householdId, family.deviceId, counter, kind, payload,
        predecessor, digest, randomBytes(64), now);
    predecessor = digest;
    return { counter, payload };
  };
  db.transaction(() => {
    db.prepare("INSERT INTO managed_scopes " +
      "(household_id,profile_id,id,kind,state,created_by_device_id,created_at) " +
      "VALUES (?,?,?,'draft','active',?,?)")
      .run(family.householdId, family.profileId, scopeId, family.deviceId, now);
    const registration = action("key");
    db.prepare("INSERT INTO managed_key_identities " +
      "(household_id,profile_id,scope_id,key_id,epoch,purpose," +
      "key_commitment,signed_payload_sha256,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,1,'draft',?,?,?,?,?)")
      .run(family.householdId, family.profileId, scopeId, keyId, commitment,
        registration.payload, family.deviceId, registration.counter, now);
    const activation = action("key");
    db.prepare("INSERT INTO managed_active_key_events " +
      "(household_id,profile_id,scope_id,sequence,previous_sha256," +
      "previous_key_id,previous_epoch,event_sha256,key_id,epoch,purpose," +
      "key_commitment,registration_sha256,issuer_device_id,session_id," +
      "issuer_counter,created_at) " +
      "VALUES (?,?,?,1,NULL,NULL,NULL,?,?,1,'draft',?,?,?,?,?,?)")
      .run(family.householdId, family.profileId, scopeId,
        activation.payload, keyId, commitment, registration.payload,
        family.deviceId, family.session.sessionId, activation.counter, now);
    db.prepare("INSERT INTO managed_grant_heads " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "head_sha256,capability_mask,updated_at) VALUES (?,?,?,?,0,NULL,0,?)")
      .run(family.householdId, family.profileId, scopeId, family.deviceId, now);
    const grant = action("grant");
    db.prepare("INSERT INTO managed_grant_events " +
      "(household_id,profile_id,scope_id,subject_device_id,sequence," +
      "previous_sha256,event_sha256,capability_mask,issuer_device_id," +
      "issuer_counter,created_at) VALUES (?,?,?,?,1,NULL,?,3,?,?,?)")
      .run(family.householdId, family.profileId, scopeId, family.deviceId,
        grant.payload, family.deviceId, grant.counter, now);
  }).immediate();
}
