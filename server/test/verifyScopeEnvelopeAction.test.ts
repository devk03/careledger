import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { encodeScopeEnvelopeActionPayloadV1,
  encodeScopeKeyEnvelopeV2, SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1,
  SCOPE_ENVELOPE_ACTION_PAYLOAD_BYTES_V1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { ScopeEnvelopeActionDeniedError, verifyScopeEnvelopeAction,
  type ScopeEnvelopeRowCandidate, type SignedScopeEnvelopeActionRow } from
  "../src/managed/verifyScopeEnvelopeAction.js";

const id = (byte: string) => byte.repeat(16);
const digest = (byte: string) => byte.repeat(32);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function fictionalFixture(counter = 1n) {
  const issuer = generateKeyPairSync("ed25519");
  const recipient = generateKeyPairSync("x25519");
  const issuerRaw = issuer.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const recipientRaw = recipient.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const wire = encodeScopeKeyEnvelopeV2({
    format: "hpke-x25519-hkdf-sha256-aes256gcm-scope-v2",
    context: { householdId: id("aa"), careProfileId: id("bb"),
      opaqueScopeId: id("cc"), keyId: id("dd"), keyEpoch: 3,
      purpose: "source", recipientDeviceId: id("ee") },
    keyCommitmentSha256: digest("11"),
    recipientKeySha256: hash(recipientRaw),
    encapsulatedKey: new Uint8Array(32).fill(4),
    ciphertext: new Uint8Array(48).fill(5).buffer,
  });
  // A structural fictional wire suffices: the server must verify its author,
  // not decrypt or interpret HPKE ciphertext.
  const row: ScopeEnvelopeRowCandidate = {
    householdId: id("aa"), careProfileId: id("bb"),
    opaqueScopeId: id("cc"), keyId: id("dd"), keyEpoch: 3,
    purpose: "source", recipientDeviceId: id("ee"),
    keyCommitmentSha256: digest("11"),
    recipientKeySha256: hash(recipientRaw), wireVersion: 2, wire,
    wireSha256: hash(wire), activeKeyHeadSha256: digest("22"),
    grantHeadSha256: digest("33"), signedPayloadSha256: "",
    issuerDeviceId: id("ff"), issuerCounter: counter,
    sessionId: id("12"), createdAt: 1_800_000_000n,
  };
  const previous = counter === 1n ? null : digest("44");
  const payload = encodeScopeEnvelopeActionPayloadV1({
    householdId: row.householdId, careProfileId: row.careProfileId,
    opaqueScopeId: row.opaqueScopeId, keyId: row.keyId,
    keyEpoch: row.keyEpoch, purpose: row.purpose,
    recipientDeviceId: row.recipientDeviceId,
    keyCommitmentSha256: row.keyCommitmentSha256,
    recipientKeySha256: row.recipientKeySha256, wireSha256: row.wireSha256,
    activeKeyHeadSha256: row.activeKeyHeadSha256,
    grantHeadSha256: row.grantHeadSha256,
    issuerDeviceId: row.issuerDeviceId, issuerCounter: row.issuerCounter,
    sessionId: row.sessionId, createdAt: row.createdAt,
    previousActionSha256: previous,
    issuerSigningKeySha256: hash(issuerRaw),
  });
  const signature = sign(null, payload, issuer.privateKey);
  row.signedPayloadSha256 = hash(payload);
  const action: SignedScopeEnvelopeActionRow = {
    householdId: row.householdId, deviceId: row.issuerDeviceId,
    counter: row.issuerCounter, actionKind: "envelope",
    payloadSha256: row.signedPayloadSha256,
    previousActionSha256: previous,
    actionSha256: hash(Buffer.concat([
      Buffer.from(SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1),
      Buffer.from(payload), signature,
    ])), signature, createdAt: row.createdAt,
  };
  const trusted = {
    enrolledIssuerSigningPublicKey: issuerRaw,
    enrolledRecipientEncryptionPublicKey: recipientRaw,
    currentActiveKeyHeadSha256: row.activeKeyHeadSha256,
    currentGrantHeadSha256: row.grantHeadSha256,
    expectedPreviousActionSha256: previous,
    authenticatedSessionId: row.sessionId,
    authenticatedIssuerDeviceId: row.issuerDeviceId,
  };
  return { row, action, trusted, payload };
}

function check(fixture: ReturnType<typeof fictionalFixture>): void {
  verifyScopeEnvelopeAction({ row: fixture.row, action: fixture.action,
    ...fixture.trusted });
}

it("accepts a correctly signed fictional envelope action and pins its payload layout", () => {
  const fixture = fictionalFixture();
  expect(fixture.payload.byteLength).toBe(SCOPE_ENVELOPE_ACTION_PAYLOAD_BYTES_V1);
  expect(Buffer.from(fixture.payload.subarray(0, 8)).toString("hex"))
    .toBe("4144534501010100");
  expect(Buffer.from(fixture.payload.subarray(8, 24)).toString("hex"))
    .toBe(id("aa"));
  expect(Buffer.from(fixture.payload.subarray(120, 128)).toString("hex"))
    .toBe("0000000302000000");
  expect(() => check(fixture)).not.toThrow();
  expect(() => check(fictionalFixture(2n))).not.toThrow();
});

it("rejects altered stored row, wire, enrolled keys, heads and signed action", () => {
  const changes: Array<(value: ReturnType<typeof fictionalFixture>) => void> = [
    (f) => { f.row.householdId = id("01"); },
    (f) => { f.row.careProfileId = id("01"); },
    (f) => { f.row.opaqueScopeId = id("01"); },
    (f) => { f.row.keyId = id("01"); },
    (f) => { f.row.keyEpoch++; },
    (f) => { f.row.purpose = "day"; },
    (f) => { f.row.recipientDeviceId = id("01"); },
    (f) => { f.row.keyCommitmentSha256 = digest("01"); },
    (f) => { f.row.recipientKeySha256 = digest("01"); },
    (f) => { f.row.wireVersion = 1 as 2; },
    (f) => { f.row.wire[239]! ^= 1; },
    (f) => { f.row.wireSha256 = digest("01"); },
    (f) => { f.row.activeKeyHeadSha256 = digest("01"); },
    (f) => { f.row.grantHeadSha256 = digest("01"); },
    (f) => { f.row.signedPayloadSha256 = digest("01"); },
    (f) => { f.row.issuerDeviceId = id("01"); },
    (f) => { f.row.issuerCounter++; },
    (f) => { f.row.sessionId = id("01"); },
    (f) => { f.row.createdAt++; },
    (f) => { f.action.actionKind = "grant"; },
    (f) => { f.action.householdId = id("01"); },
    (f) => { f.action.deviceId = id("01"); },
    (f) => { f.action.counter++; },
    (f) => { f.action.createdAt++; },
    (f) => { f.action.payloadSha256 = digest("01"); },
    (f) => { f.action.actionSha256 = digest("01"); },
    (f) => { f.action.signature[0]! ^= 1; },
    (f) => { f.action.previousActionSha256 = digest("01"); },
    (f) => { f.trusted.enrolledIssuerSigningPublicKey[0]! ^= 1; },
    (f) => { f.trusted.enrolledRecipientEncryptionPublicKey[0]! ^= 1; },
    (f) => { f.trusted.currentActiveKeyHeadSha256 = digest("01"); },
    (f) => { f.trusted.currentGrantHeadSha256 = digest("01"); },
    (f) => { f.trusted.authenticatedSessionId = id("01"); },
    (f) => { f.trusted.authenticatedIssuerDeviceId = id("01"); },
  ];
  for (const change of changes) {
    const fixture = fictionalFixture(2n);
    change(fixture);
    expect(() => check(fixture))
      .toThrow(ScopeEnvelopeActionDeniedError);
  }
  const stale = fictionalFixture(2n);
  stale.trusted.expectedPreviousActionSha256 = digest("01");
  expect(() => check(stale))
    .toThrow(ScopeEnvelopeActionDeniedError);
});

it("verifies the fixed browser Ed25519 interoperability vector", () => {
  const recipientRaw = new Uint8Array(32).fill(0x77);
  const issuerRaw = Buffer.from(
    "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12", "hex");
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
  const row: ScopeEnvelopeRowCandidate = {
    householdId: id("aa"), careProfileId: id("bb"),
    opaqueScopeId: id("cc"), keyId: id("dd"), keyEpoch: 3,
    purpose: "source", recipientDeviceId: id("ee"),
    keyCommitmentSha256: digest("11"),
    recipientKeySha256:
      "e29442e61ad354e5cb0831e2e8359e8fb50cf024ad5a8f407c8f9de63bdf7371",
    wireVersion: 2, wire,
    wireSha256: "aea52eff95e85ee622ff35ec8333d52d856f58ee0dc8c8f83be60fd5523096ea",
    activeKeyHeadSha256: digest("22"), grantHeadSha256: digest("33"),
    signedPayloadSha256:
      "e94509ee23212d45ade1f3569f07cff3a12624275bd78f16c0a640ea6e389f33",
    issuerDeviceId: id("ff"), issuerCounter: 2n,
    sessionId: id("12"), createdAt: 1_800_000_000n,
  };
  const action: SignedScopeEnvelopeActionRow = {
    householdId: row.householdId, deviceId: row.issuerDeviceId,
    counter: row.issuerCounter, actionKind: "envelope",
    payloadSha256: row.signedPayloadSha256,
    previousActionSha256: digest("44"),
    actionSha256:
      "5eb17a3c1e4b024cafc24a3d5ac741be8b9926a5d57055ae9b88e970cd776444",
    signature: Buffer.from(
      "1c35f3f65fc89928f46aebf74df6bed3ac09dcefccef9ded7e54c33d5a783d4" +
      "e428cfaa3e5a0087f253b6e40a077473deed93f739db83106877fbecd73a9860d", "hex"),
    createdAt: row.createdAt,
  };
  expect(hash(recipientRaw)).toBe(row.recipientKeySha256);
  expect(hash(wire)).toBe(row.wireSha256);
  expect(() => verifyScopeEnvelopeAction({ row, action,
    enrolledIssuerSigningPublicKey: issuerRaw,
    enrolledRecipientEncryptionPublicKey: recipientRaw,
    currentActiveKeyHeadSha256: row.activeKeyHeadSha256,
    currentGrantHeadSha256: row.grantHeadSha256,
    expectedPreviousActionSha256: digest("44"),
    authenticatedSessionId: row.sessionId,
    authenticatedIssuerDeviceId: row.issuerDeviceId }))
    .not.toThrow();
});
