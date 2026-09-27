import { encodeManagedVaultBlobV2,
  encodePendingDraftPairActionPayloadV1, MANAGED_VAULT_CHUNK_BYTES,
  MANAGED_VAULT_FORMAT_V2, PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1,
  PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1 } from "@adeno/contracts";
import { expect, it, vi } from "vitest";

import { prepareLocalEncryptedDraft } from "../managed/intakeDraft";
import { generateDeviceEncryptionKeys } from "./dayKeyEnvelope";
import { createScopeKeyEnvelopesV2 } from "./scopeKeyEnvelopeV2";
import { generateIndexSigningKeys } from "./signedIndexHead";
import { signPendingDraftPair, SignedPendingDraftPairError } from
  "./signedPendingDraftPair";

const id = (byte: string) => byte.repeat(16);
const digest = (byte: string) => byte.repeat(32);
const hex = (bytes: Uint8Array) => Array.from(bytes,
  (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => Uint8Array.from(value.match(/../gu)!,
  (pair) => Number.parseInt(pair, 16));
const sha256 = async (bytes: Uint8Array) => hex(new Uint8Array(
  await crypto.subtle.digest("SHA-256", bytes)));

function fictionalWire(blobId: string, ivByte: number,
  ciphertextByte: number): Uint8Array {
  return encodeManagedVaultBlobV2({ format: MANAGED_VAULT_FORMAT_V2,
    blobId: fromHex(blobId), plaintextSize: 1,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [{ iv: new Uint8Array(12).fill(ivByte),
      ciphertext: new Uint8Array(17).fill(ciphertextByte).buffer }] });
}

function claims() {
  return { householdId: id("aa"), careProfileId: id("bb"),
    opaqueDraftScopeId: id("cc"), keyId: id("dd"),
    reservationId: id("ee"), contentIntentId: id("10"),
    metadataIntentId: id("20"), contentBlobId: id("30"),
    metadataBlobId: id("40"), contentObjectId: id("50"),
    metadataObjectId: id("60"), authorDeviceId: id("70"),
    sessionId: id("80"), keyEpoch: 3, authorCounter: 2n,
    pairedAt: 1_800_000_000n, keyCommitmentSha256: digest("11"),
    activeKeyHeadSha256: digest("22"), grantHeadSha256: digest("33"),
    previousActionSha256: digest("44") };
}

async function fictionalFixture(kind: "family_note" | "file" = "family_note") {
  const signingKeys = await generateIndexSigningKeys();
  const signedClaims = claims();
  const recipientEncryptionKeys = await generateDeviceEncryptionKeys();
  const created = await createScopeKeyEnvelopesV2({
    householdId: signedClaims.householdId,
    careProfileId: signedClaims.careProfileId,
    opaqueScopeId: signedClaims.opaqueDraftScopeId,
    keyId: signedClaims.keyId, keyEpoch: signedClaims.keyEpoch,
    purpose: "draft",
  }, [{ deviceId: signedClaims.authorDeviceId,
    publicKey: recipientEncryptionKeys.publicKey }]);
  signedClaims.keyCommitmentSha256 = created.keyCommitmentSha256;
  const draftKey = created.key;
  const identity = { householdId: signedClaims.householdId,
    careProfileId: signedClaims.careProfileId,
    opaqueDraftId: signedClaims.opaqueDraftScopeId,
    keyEpoch: signedClaims.keyEpoch };
  const common = { key: draftKey, identity,
    reservedBlobIds: { content: signedClaims.contentBlobId,
      metadata: signedClaims.metadataBlobId },
    clientSelectedAt: "2026-04-09T12:00:00.000Z",
    candidateCareDays: ["2026-04-07"] };
  const fictionalPdf = new TextEncoder().encode(
    "%PDF-1.4\nFICTIONAL_DOCUMENT_NOT_A_REAL_RECORD\n");
  const draft = kind === "file" ? await prepareLocalEncryptedDraft({
    ...common, kind: "file",
    file: { name: "fictional-visit.pdf", size: fictionalPdf.byteLength,
      arrayBuffer: async () => fictionalPdf.buffer.slice(0) },
  }) : await prepareLocalEncryptedDraft({ ...common, kind: "family_note",
    body: "Fictional note about an imaginary appointment.",
    authorLabel: "Fictional caregiver" });
  signedClaims.contentObjectId = draft.contentObjectId;
  signedClaims.metadataObjectId = draft.metadataObjectId;
  const receipts = new Map([
    [`/api/v3/vault/intents/${signedClaims.contentIntentId}/blobs/` +
      `${signedClaims.contentBlobId}/receipt`,
    { status: "committed", wireSha256: await sha256(draft.contentWire),
      wireBytes: draft.contentWire.byteLength }],
    [`/api/v3/vault/intents/${signedClaims.metadataIntentId}/blobs/` +
      `${signedClaims.metadataBlobId}/receipt`,
    { status: "committed", wireSha256: await sha256(draft.metadataWire),
      wireBytes: draft.metadataWire.byteLength }],
  ] as const);
  const fetcher = vi.fn(async (path: RequestInfo | URL) => {
    const body = receipts.get(String(path));
    return new Response(JSON.stringify(body ?? { error: "not found" }),
      { status: body ? 200 : 404 });
  });
  return { claims: signedClaims, contentWire: draft.contentWire,
    metadataWire: draft.metadataWire,
    draftKeyEnvelope: created.envelopes[0]!,
    recipientEncryptionKeys, signingKeys, csrfToken: "fictional-csrf",
    fetcher,
    preparationKey: draftKey };
}

it("signs exact fictional v2 wires as a pending pair, not adult approval", async () => {
  const input = await fictionalFixture();
  const signed = await signPendingDraftPair(input);
  expect(signed.payload.byteLength)
    .toBe(PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1);
  expect(hex(signed.payload.subarray(0, 8))).toBe("4144505001010101");
  expect(hex(signed.payload.subarray(8, 24)))
    .toBe(input.claims.householdId);
  expect(signed.context.contentWireBytes).toBe(input.contentWire.byteLength);
  expect(signed.context.metadataWireBytes).toBe(input.metadataWire.byteLength);
  expect(signed.context.contentWireSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", input.contentWire))));
  expect(signed.context.metadataWireSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", input.metadataWire))));
  expect(await crypto.subtle.verify("Ed25519", input.signingKeys.publicKey,
    signed.signature, signed.payload)).toBe(true);
  expect(input.fetcher).toHaveBeenCalledTimes(2);
  const message = new Uint8Array([
    ...new TextEncoder().encode(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
    ...signed.payload, ...signed.signature,
  ]);
  expect(signed.actionSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", message))));
});

it("also authenticates an encrypted fictional PDF pair before signing", async () => {
  const input = await fictionalFixture("file");
  const signed = await signPendingDraftPair(input);
  expect(signed.context.contentWireBytes).toBe(input.contentWire.byteLength);
  expect(await crypto.subtle.verify("Ed25519", input.signingKeys.publicKey,
    signed.signature, signed.payload)).toBe(true);
});

it("rejects swapped blob IDs, invalid predecessor, and mismatched signing keys", async () => {
  const input = await fictionalFixture();
  await expect(signPendingDraftPair({ ...input,
    claims: { ...input.claims,
      contentBlobId: input.claims.metadataBlobId,
      metadataBlobId: input.claims.contentBlobId } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  await expect(signPendingDraftPair({ ...input,
    claims: { ...input.claims, previousActionSha256: null } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  const other = await generateIndexSigningKeys();
  await expect(signPendingDraftPair({ ...input,
    signingKeys: { privateKey: input.signingKeys.privateKey,
      publicKey: other.publicKey } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
});

it("rejects unauthenticated wires, a wrong key, wrong AAD, and unrelated encrypted metadata", async () => {
  const input = await fictionalFixture();
  await expect(signPendingDraftPair({ ...input,
    contentWire: fictionalWire(input.claims.contentBlobId, 1, 3) }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  const other = await fictionalFixture();
  await expect(signPendingDraftPair({ ...input,
    draftKeyEnvelope: other.draftKeyEnvelope }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  await expect(signPendingDraftPair({ ...input,
    claims: { ...input.claims, keyCommitmentSha256: digest("fe") } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  await expect(signPendingDraftPair({ ...input,
    claims: { ...input.claims, keyId: id("fe") } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  await expect(signPendingDraftPair({ ...input,
    claims: { ...input.claims, contentObjectId: id("fe") } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  const changed = input.contentWire.slice();
  changed[changed.length - 1]! ^= 1;
  await expect(signPendingDraftPair({ ...input, contentWire: changed }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  const second = await prepareLocalEncryptedDraft({ kind: "family_note",
    key: input.preparationKey,
    identity: { householdId: input.claims.householdId,
      careProfileId: input.claims.careProfileId,
      opaqueDraftId: input.claims.opaqueDraftScopeId,
      keyEpoch: input.claims.keyEpoch },
    reservedBlobIds: { content: id("91"),
      metadata: input.claims.metadataBlobId },
    body: "A different fictional note", authorLabel: "Fictional caregiver",
    clientSelectedAt: "2026-04-09T12:00:00.000Z",
    candidateCareDays: [] });
  await expect(signPendingDraftPair({ ...input,
    metadataWire: second.metadataWire,
    claims: { ...input.claims,
      metadataObjectId: second.metadataObjectId } }))
    .rejects.toBeInstanceOf(SignedPendingDraftPairError);
});

it("refuses to sign if either exact ciphertext upload is unconfirmed or mismatched", async () => {
  const input = await fictionalFixture();
  const contentPath = `/api/v3/vault/intents/${input.claims.contentIntentId}/` +
    `blobs/${input.claims.contentBlobId}/receipt`;
  const metadataPath = `/api/v3/vault/intents/${input.claims.metadataIntentId}/` +
    `blobs/${input.claims.metadataBlobId}/receipt`;
  for (const [path, status, body] of [
    [contentPath, 202, { status: "unconfirmed" }],
    [metadataPath, 202, { status: "unconfirmed" }],
    [contentPath, 200, { status: "committed", wireSha256: digest("ee"),
      wireBytes: input.contentWire.byteLength }],
    [metadataPath, 200, { status: "committed",
      wireSha256: await sha256(input.metadataWire),
      wireBytes: input.metadataWire.byteLength + 1 }],
    [contentPath, 404, { error: "not found" }],
  ] as const) {
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url) === path ? new Response(JSON.stringify(body), { status }) :
        input.fetcher(url));
    await expect(signPendingDraftPair({ ...input, fetcher }))
      .rejects.toBeInstanceOf(SignedPendingDraftPairError);
  }
});

it("timestamps the pair after both receipt checks", async () => {
  const input = await fictionalFixture();
  let clock = 1_800_000_000_000;
  const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
  try {
    const fetcher = vi.fn(async (path: RequestInfo | URL) => {
      const response = await input.fetcher(path);
      if (String(path).includes(input.claims.metadataIntentId))
        clock += 12_000;
      return response;
    });
    const signed = await signPendingDraftPair({ ...input, fetcher });
    expect(signed.context.pairedAt).toBe(1_800_000_012n);
  } finally { now.mockRestore(); }
});

it("snapshots caller wires and IDs before asynchronous signing", async () => {
  const input = await fictionalFixture();
  const originalWire = input.contentWire.slice();
  const originalDeviceId = input.claims.authorDeviceId;
  const pending = signPendingDraftPair(input);
  input.contentWire.fill(0);
  input.claims.authorDeviceId = id("00");
  const signed = await pending;
  expect(signed.context.authorDeviceId).toBe(originalDeviceId);
  expect(signed.context.contentWireSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", originalWire))));
});

it("uses a fixed synthetic payload and Ed25519 key for browser/Node interoperability", async () => {
  const seed = new Uint8Array(32).fill(0x42);
  const pkcs8 = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b,
    0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...seed,
  ]);
  const publicRaw = fromHex(
    "2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12");
  const signingKeys = { privateKey: await crypto.subtle.importKey("pkcs8",
    pkcs8, "Ed25519", false, ["sign"]),
  publicKey: await crypto.subtle.importKey("raw", publicRaw,
    "Ed25519", true, ["verify"]) };
  const signedClaims = claims();
  const contentWire = fictionalWire(signedClaims.contentBlobId, 1, 3);
  const metadataWire = fictionalWire(signedClaims.metadataBlobId, 2, 4);
  const payload = encodePendingDraftPairActionPayloadV1({
    ...signedClaims,
    contentWireBytes: contentWire.byteLength,
    metadataWireBytes: metadataWire.byteLength,
    contentWireSha256: await sha256(contentWire),
    metadataWireSha256: await sha256(metadataWire),
    issuerSigningKeySha256: await sha256(publicRaw),
  });
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519",
    signingKeys.privateKey, payload));
  const actionSha256 = await sha256(new Uint8Array([
    ...new TextEncoder().encode(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
    ...payload, ...signature]));
  expect(await sha256(payload))
    .toBe("4ee78b2fad67798e772bd7d3673e2a9efd248c76d62bc588e5a07f987269cca7");
  expect(hex(signature)).toBe(
    "d624e141ba8484266d022ab512e39fe295e732aabfb90d917ccbe27da2b4aa" +
    "7b08d446cac897790c8279470bf2bbf6f74cea832fc3fd0dc32c74717f9429ac08");
  expect(actionSha256)
    .toBe("5b6028020594a7e132725ad8b072f9b1a83fb3d1b9dcf48b4f7a32a6e6e80249");
});
