import { encodeManagedVaultBlobV2, MANAGED_VAULT_CHUNK_BYTES,
  MANAGED_VAULT_FORMAT_V2, PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1,
  PENDING_DRAFT_PAIR_ACTION_PAYLOAD_BYTES_V1 } from "@adeno/contracts";
import { expect, it } from "vitest";

import { generateIndexSigningKeys } from "./signedIndexHead";
import { signPendingDraftPair, SignedPendingDraftPairError } from
  "./signedPendingDraftPair";

const id = (byte: string) => byte.repeat(16);
const digest = (byte: string) => byte.repeat(32);
const hex = (bytes: Uint8Array) => Array.from(bytes,
  (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => Uint8Array.from(value.match(/../gu)!,
  (pair) => Number.parseInt(pair, 16));

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

async function fictionalFixture() {
  const signingKeys = await generateIndexSigningKeys();
  const signedClaims = claims();
  return { claims: signedClaims,
    contentWire: fictionalWire(signedClaims.contentBlobId, 1, 3),
    metadataWire: fictionalWire(signedClaims.metadataBlobId, 2, 4),
    signingKeys };
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
  const message = new Uint8Array([
    ...new TextEncoder().encode(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
    ...signed.payload, ...signed.signature,
  ]);
  expect(signed.actionSha256).toBe(hex(new Uint8Array(
    await crypto.subtle.digest("SHA-256", message))));
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

it("uses a fixed synthetic Ed25519 key for browser/Node interoperability", async () => {
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
  const signed = await signPendingDraftPair({ claims: signedClaims,
    contentWire: fictionalWire(signedClaims.contentBlobId, 1, 3),
    metadataWire: fictionalWire(signedClaims.metadataBlobId, 2, 4),
    signingKeys });
  expect(signed.payloadSha256)
    .toBe("4ee78b2fad67798e772bd7d3673e2a9efd248c76d62bc588e5a07f987269cca7");
  expect(hex(signed.signature)).toBe(
    "d624e141ba8484266d022ab512e39fe295e732aabfb90d917ccbe27da2b4aa" +
    "7b08d446cac897790c8279470bf2bbf6f74cea832fc3fd0dc32c74717f9429ac08");
  expect(signed.actionSha256)
    .toBe("5b6028020594a7e132725ad8b072f9b1a83fb3d1b9dcf48b4f7a32a6e6e80249");
});
