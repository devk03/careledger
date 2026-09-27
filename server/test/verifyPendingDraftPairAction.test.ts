import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { encodeManagedVaultBlobV2,
  encodePendingDraftPairActionPayloadV1, MANAGED_VAULT_CHUNK_BYTES,
  MANAGED_VAULT_FORMAT_V2, PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1,
  PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1,
  type PendingDraftPairActionContextV1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { PendingDraftPairActionDenied, verifyPendingDraftPairAction,
  type SignedPendingDraftPairActionRow } from
  "../src/managed/verifyPendingDraftPairAction.js";

const id = (byte: string) => byte.repeat(16);
const digest = (byte: string) => byte.repeat(32);
const hash = (bytes: Uint8Array) => createHash("sha256")
  .update(bytes).digest("hex");

function wire(blobId: string, ivByte: number, ciphertextByte: number) {
  return encodeManagedVaultBlobV2({ format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(blobId, "hex"), plaintextSize: 1,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [{ iv: new Uint8Array(12).fill(ivByte),
      ciphertext: new Uint8Array(17).fill(ciphertextByte).buffer }] });
}

function context(signingPublicKey: Uint8Array):
  PendingDraftPairActionContextV1 {
  return { householdId: id("aa"), careProfileId: id("bb"),
    opaqueDraftScopeId: id("cc"), keyId: id("dd"),
    reservationId: id("ee"), contentIntentId: id("10"),
    metadataIntentId: id("20"), contentBlobId: id("30"),
    metadataBlobId: id("40"), contentObjectId: id("50"),
    metadataObjectId: id("60"), authorDeviceId: id("70"),
    sessionId: id("80"), keyEpoch: 3, authorCounter: 2n,
    pairedAt: 1_800_000_000n, contentWireBytes: 66,
    metadataWireBytes: 66, keyCommitmentSha256: digest("11"),
    activeKeyHeadSha256: digest("22"), grantHeadSha256: digest("33"),
    contentWireSha256: hash(wire(id("30"), 1, 3)),
    metadataWireSha256: hash(wire(id("40"), 2, 4)),
    previousActionSha256: digest("44"),
    issuerSigningKeySha256: hash(signingPublicKey) };
}

function fictionalFixture() {
  const keys = generateKeyPairSync("ed25519");
  const rawPublic = keys.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32);
  const claims = context(rawPublic);
  const payload = encodePendingDraftPairActionPayloadV1(claims);
  const signature = sign(null, payload, keys.privateKey);
  const pairSha256 = hash(payload);
  const action: SignedPendingDraftPairActionRow = {
    householdId: claims.householdId, deviceId: claims.authorDeviceId,
    counter: claims.authorCounter, actionKind: "review",
    payloadSha256: pairSha256,
    previousActionSha256: claims.previousActionSha256,
    actionSha256: hash(Buffer.concat([
      Buffer.from(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
      Buffer.from(payload), signature,
    ])), signature, createdAt: claims.pairedAt,
  };
  const trusted = { current: { ...claims },
    enrolledAuthorSigningPublicKey: Buffer.from(rawPublic),
    expectedCounter: claims.authorCounter,
    expectedPreviousActionSha256: claims.previousActionSha256,
    authenticatedSessionId: claims.sessionId,
    authenticatedAuthorDeviceId: claims.authorDeviceId,
    nowUnixSeconds: claims.pairedAt };
  return { claims, action, pairSha256, trusted, payload };
}

function check(fixture: ReturnType<typeof fictionalFixture>) {
  verifyPendingDraftPairAction({ context: fixture.claims,
    pairSha256: fixture.pairSha256, action: fixture.action,
    ...fixture.trusted });
}

it("accepts a signed fictional pending pair and pins its exact byte layout", () => {
  const fixture = fictionalFixture();
  expect(fixture.payload.byteLength)
    .toBe(PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1);
  expect(Buffer.from(fixture.payload.subarray(0, 8)).toString("hex"))
    .toBe("4144505001010101");
  expect(Buffer.from(fixture.payload.subarray(8, 24)).toString("hex"))
    .toBe(fixture.claims.householdId);
  expect(Buffer.from(fixture.payload.subarray(216, 224)).toString("hex"))
    .toBe("0000000303000000");
  expect(() => check(fixture)).not.toThrow();
});

it("rejects changed pair identities, wire evidence, heads, session and action", () => {
  const changes: Array<(fixture: ReturnType<typeof fictionalFixture>) => void> = [
    (f) => { f.claims.householdId = id("01"); },
    (f) => { f.claims.careProfileId = id("01"); },
    (f) => { f.claims.opaqueDraftScopeId = id("01"); },
    (f) => { f.claims.keyId = id("01"); },
    (f) => { f.claims.keyEpoch++; },
    (f) => { f.claims.reservationId = id("01"); },
    (f) => { f.claims.contentIntentId = id("01"); },
    (f) => { f.claims.metadataIntentId = id("01"); },
    (f) => { f.claims.contentBlobId = id("01"); },
    (f) => { f.claims.metadataBlobId = id("01"); },
    (f) => { f.claims.contentObjectId = id("01"); },
    (f) => { f.claims.metadataObjectId = id("01"); },
    (f) => { f.claims.contentWireBytes++; },
    (f) => { f.claims.metadataWireBytes++; },
    (f) => { f.claims.contentWireSha256 = digest("01"); },
    (f) => { f.claims.metadataWireSha256 = digest("01"); },
    (f) => { f.claims.keyCommitmentSha256 = digest("01"); },
    (f) => { f.claims.activeKeyHeadSha256 = digest("01"); },
    (f) => { f.claims.grantHeadSha256 = digest("01"); },
    (f) => { f.claims.authorCounter++; },
    (f) => { f.claims.authorDeviceId = id("01"); },
    (f) => { f.claims.sessionId = id("01"); },
    (f) => { f.claims.pairedAt++; },
    (f) => { f.claims.previousActionSha256 = digest("01"); },
    (f) => { f.claims.issuerSigningKeySha256 = digest("01"); },
    (f) => { f.action.payloadSha256 = digest("01"); },
    (f) => { f.action.actionSha256 = digest("01"); },
    (f) => { f.action.actionKind = "grant"; },
    (f) => { f.action.signature[0]! ^= 1; },
    (f) => { f.action.previousActionSha256 = digest("01"); },
    (f) => { f.trusted.current.contentWireSha256 = digest("01"); },
    (f) => { f.trusted.enrolledAuthorSigningPublicKey[0]! ^= 1; },
    (f) => { f.trusted.expectedPreviousActionSha256 = digest("01"); },
    (f) => { f.trusted.authenticatedSessionId = id("01"); },
    (f) => { f.trusted.nowUnixSeconds += 6n; },
  ];
  for (const change of changes) {
    const fixture = fictionalFixture();
    change(fixture);
    expect(() => check(fixture)).toThrow(PendingDraftPairActionDenied);
  }
});

it("verifies the fixed browser Ed25519 vector with Node crypto", () => {
  const rawPublic = Buffer.from(
    "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12",
    "hex");
  const claims = context(rawPublic);
  const pairSha256 =
    "4ee78b2fad67798e772bd7d3673e2a9efd248c76d62bc588e5a07f987269cca7";
  const action: SignedPendingDraftPairActionRow = {
    householdId: claims.householdId, deviceId: claims.authorDeviceId,
    counter: 2n, actionKind: "review", payloadSha256: pairSha256,
    previousActionSha256: digest("44"),
    actionSha256:
      "5b6028020594a7e132725ad8b072f9b1a83fb3d1b9dcf48b4f7a32a6e6e80249",
    signature: Buffer.from(
      "d624e141ba8484266d022ab512e39fe295e732aabfb90d917ccbe27da2b4aa" +
      "7b08d446cac897790c8279470bf2bbf6f74cea832fc3fd0dc32c74717f9429ac08",
      "hex"), createdAt: claims.pairedAt,
  };
  expect(hash(encodePendingDraftPairActionPayloadV1(claims)))
    .toBe(pairSha256);
  expect(() => verifyPendingDraftPairAction({ context: claims,
    pairSha256, action, current: { ...claims },
    enrolledAuthorSigningPublicKey: rawPublic,
    expectedCounter: 2n,
    expectedPreviousActionSha256: digest("44"),
    authenticatedSessionId: claims.sessionId,
    authenticatedAuthorDeviceId: claims.authorDeviceId,
    nowUnixSeconds: claims.pairedAt })).not.toThrow();
});
