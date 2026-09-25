import { createHash } from "node:crypto";

import { encodeScopeEnvelopeBackfillPayloadV1, encodeScopeKeyEnvelopeV2,
  SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { ScopeEnvelopeBackfillDeniedError, verifyScopeEnvelopeBackfill,
  type ScopeEnvelopeBackfillRowCandidate } from
  "../src/managed/verifyScopeEnvelopeBackfill.js";
import type { SignedScopeEnvelopeActionRow } from
  "../src/managed/verifyScopeEnvelopeAction.js";

const id = (byte: string) => byte.repeat(16);
const digest = (byte: string) => byte.repeat(32);
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fictionalVector() {
  const issuerRaw = Buffer.from(
    "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12", "hex");
  const recipientRaw = new Uint8Array(32).fill(0x77);
  const wire = encodeScopeKeyEnvelopeV2({
    format: "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2",
    context: { householdId: id("aa"), careProfileId: id("bb"),
      opaqueScopeId: id("cc"), keyId: id("dd"), keyEpoch: 3,
      purpose: "source", recipientDeviceId: id("ee") },
    keyCommitmentSha256: digest("11"),
    recipientKeySha256:
      "e29442e61ad354e5cb0831e2e8359e8fb50cf024ad5a8f407c8f9de63bdf7371",
    encapsulatedKey: new Uint8Array(32).fill(4),
    ciphertext: new Uint8Array(48).fill(5).buffer,
  });
  const row: ScopeEnvelopeBackfillRowCandidate = {
    householdId: id("aa"), careProfileId: id("bb"),
    opaqueScopeId: id("cc"), keyId: id("dd"), keyEpoch: 3,
    purpose: "source", recipientDeviceId: id("ee"),
    keyCommitmentSha256: digest("11"),
    recipientKeySha256:
      "e29442e61ad354e5cb0831e2e8359e8fb50cf024ad5a8f407c8f9de63bdf7371",
    wireVersion: 2, wire,
    wireSha256: "aea52eff95e85ee622ff35ec8333d52d856f58ee0dc8c8f83be60fd5523096ea",
    historicalActivationSequence: 3n,
    historicalActivationSha256: digest("66"),
    currentActiveKeySequence: 4n,
    currentActiveKeyHeadSha256: digest("22"),
    currentGrantSequence: 2n,
    currentGrantHeadSha256: digest("33"),
    signedPayloadSha256:
      "48b19dae5e2da358f43900527561076bae28cd97c55733caa8d26fed5827320e",
    issuerDeviceId: id("ff"), issuerCounter: 2n,
    sessionId: id("12"), createdAt: 1_800_000_000n,
  };
  const action: SignedScopeEnvelopeActionRow = {
    householdId: row.householdId, deviceId: row.issuerDeviceId,
    counter: row.issuerCounter, actionKind: "envelope",
    payloadSha256: row.signedPayloadSha256,
    previousActionSha256: digest("44"),
    actionSha256:
      "75244649b176653d6cccb655a1144fbb6fb28ff8045c9d1ca917084e4f214d92",
    signature: Buffer.from(
      "4c39a664a45081b01197728580f59170f8f3483f2523b5e7630377d626cf10b" +
      "06f833f83efaeab0888485388ed39e2530f319746221255b874ab81779890460c", "hex"),
    createdAt: row.createdAt,
  };
  const trusted = {
    enrolledIssuerSigningPublicKey: issuerRaw,
    enrolledRecipientEncryptionPublicKey: recipientRaw,
    historicalActivationSequence: row.historicalActivationSequence,
    historicalActivationSha256: row.historicalActivationSha256,
    currentActiveKeySequence: row.currentActiveKeySequence,
    currentActiveKeyEpoch: 4,
    currentActiveKeyHeadSha256: row.currentActiveKeyHeadSha256,
    currentGrantSequence: row.currentGrantSequence,
    currentGrantHeadSha256: row.currentGrantHeadSha256,
    expectedPreviousActionSha256: digest("44"),
    authenticatedSessionId: row.sessionId,
    authenticatedIssuerDeviceId: row.issuerDeviceId,
  };
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
    issuerDeviceId: row.issuerDeviceId, issuerCounter: row.issuerCounter,
    sessionId: row.sessionId, createdAt: row.createdAt,
    previousActionSha256: action.previousActionSha256,
    issuerSigningKeySha256: sha256(issuerRaw),
  });
  return { row, action, trusted, payload };
}

function check(fixture: ReturnType<typeof fictionalVector>): void {
  verifyScopeEnvelopeBackfill({ row: fixture.row,
    action: fixture.action, ...fixture.trusted });
}

it("verifies the fixed browser historical-backfill signature vector", () => {
  const fixture = fictionalVector();
  expect(sha256(fixture.row.wire)).toBe(fixture.row.wireSha256);
  expect(sha256(fixture.trusted.enrolledRecipientEncryptionPublicKey))
    .toBe(fixture.row.recipientKeySha256);
  expect(sha256(fixture.payload)).toBe(fixture.row.signedPayloadSha256);
  expect(() => check(fixture)).not.toThrow();
});

it("rejects an ordinary envelope action and changed historical/current heads", () => {
  const changes: Array<(f: ReturnType<typeof fictionalVector>) => void> = [
    (f) => { f.row.wire[239]! ^= 1; },
    (f) => { f.row.wireVersion = 1 as 2; },
    (f) => { f.row.householdId = id("01"); },
    (f) => { f.row.careProfileId = id("01"); },
    (f) => { f.row.keyId = id("01"); },
    (f) => { f.row.historicalActivationSequence = 2n; },
    (f) => { f.row.historicalActivationSha256 = digest("01"); },
    (f) => { f.row.currentActiveKeySequence = 5n; },
    (f) => { f.row.currentActiveKeyHeadSha256 = digest("01"); },
    (f) => { f.row.currentGrantSequence = 3n; },
    (f) => { f.row.currentGrantHeadSha256 = digest("01"); },
    (f) => { f.trusted.currentActiveKeyEpoch = 3; },
    (f) => { f.trusted.currentActiveKeyEpoch = Number.NaN; },
    (f) => { f.trusted.currentActiveKeySequence = 5n; },
    (f) => { f.trusted.currentGrantHeadSha256 = digest("01"); },
    (f) => { f.trusted.enrolledIssuerSigningPublicKey[0]! ^= 1; },
    (f) => { f.row.sessionId = id("01"); },
    (f) => { f.row.issuerDeviceId = id("01"); },
    (f) => { f.row.issuerCounter = 3n; },
    (f) => { f.row.createdAt = 1_800_000_001n; },
    (f) => { f.action.actionKind = "grant"; },
    (f) => { f.action.counter = 3n; },
    (f) => { f.trusted.expectedPreviousActionSha256 = digest("01"); },
    (f) => { f.action.signature[0]! ^= 1; },
    (f) => { f.action.actionSha256 = digest("01"); },
    (f) => { f.trusted.enrolledRecipientEncryptionPublicKey[0]! ^= 1; },
  ];
  for (const change of changes) {
    const fixture = fictionalVector();
    change(fixture);
    expect(() => check(fixture)).toThrow(ScopeEnvelopeBackfillDeniedError);
  }
  const ordinary = fictionalVector();
  ordinary.action.signature = Buffer.from(
    "1c35f3f65fc89928f46aebf74df6bed3ac09dcefccef9ded7e54c33d5a783d4" +
    "e428cfaa3e5a0087f253b6e40a077473deed93f739db83106877fbecd73a9860d", "hex");
  ordinary.action.actionSha256 = sha256(Buffer.concat([
    Buffer.from(SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1),
    Buffer.from(ordinary.payload), Buffer.from(ordinary.action.signature),
  ]));
  // All hashes and row metadata now agree; only the ordinary Ed25519 signature
  // fails against the distinct historical-backfill payload.
  expect(ordinary.action.payloadSha256)
    .toBe(sha256(ordinary.payload));
  expect(() => check(ordinary)).toThrow(ScopeEnvelopeBackfillDeniedError);
});
