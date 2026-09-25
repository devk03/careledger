import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from
  "@hpke/core";
import { SCOPE_KEY_ENVELOPE_FORMAT_V2, assertScopeKeyEnvelopeV2,
  encodeScopeKeyHeaderV2, type ScopeKeyContextV2, type ScopeKeyEnvelopeV2,
  type ScopeKeyIdentityV2, type ScopeKeyPurposeV2 } from "@adeno/contracts";

import { importVaultKey } from "./vault";

export { SCOPE_KEY_ENVELOPE_FORMAT_V2 } from "@adeno/contracts";
export type { ScopeKeyContextV2, ScopeKeyEnvelopeV2, ScopeKeyIdentityV2,
  ScopeKeyPurposeV2 } from "@adeno/contracts";

const KEY_BYTES = 32;
const MAX_RECIPIENTS = 32;
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTITY_KEYS = ["careProfileId", "householdId", "keyEpoch", "keyId",
  "opaqueScopeId", "purpose"];
const CONTEXT_KEYS = [...IDENTITY_KEYS, "recipientDeviceId"];
const COMMITMENT_DOMAIN = new TextEncoder().encode(
  "adeno:managed:key-commitment:v1\0",
);
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes256Gcm() });

export type ExpectedScopeKeyV2 = ScopeKeyContextV2 & {
  keyCommitmentSha256: string;
};

export class ScopeKeyEnvelopeV2Error extends Error {
  constructor() {
    super("This encrypted scope key could not be verified or opened.");
    this.name = "ScopeKeyEnvelopeV2Error";
  }
}

/**
 * Browser-only key creation. A valid HPKE envelope is NOT a grant or proof of
 * its sender. The caller must register the commitment and verify owner-signed
 * envelope actions, current grant/head and device enrollment separately.
 */
export async function createScopeKeyEnvelopesV2(identity: ScopeKeyIdentityV2,
  recipients: readonly { deviceId: string; publicKey: CryptoKey }[]):
  Promise<{ key: CryptoKey; keyCommitmentSha256: string;
    envelopes: ScopeKeyEnvelopeV2[] }> {
  assertIdentity(identity);
  if (!Array.isArray(recipients) || recipients.length < 1 ||
    recipients.length > MAX_RECIPIENTS) throw new ScopeKeyEnvelopeV2Error();
  const stableIdentity = { householdId: identity.householdId,
    careProfileId: identity.careProfileId, opaqueScopeId: identity.opaqueScopeId,
    keyId: identity.keyId, keyEpoch: identity.keyEpoch,
    purpose: identity.purpose };
  const stableRecipients = recipients.map((recipient) => {
    if (!recipient || typeof recipient !== "object")
      throw new ScopeKeyEnvelopeV2Error();
    assertOpaqueId(recipient.deviceId);
    assertPublicKey(recipient.publicKey);
    return { deviceId: recipient.deviceId, publicKey: recipient.publicKey };
  });
  if (new Set(stableRecipients.map((value) => value.deviceId)).size !==
    stableRecipients.length) throw new ScopeKeyEnvelopeV2Error();
  const material = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  try {
    const keyCommitmentSha256 = await scopeKeyCommitmentSha256(material);
    const envelopes: ScopeKeyEnvelopeV2[] = [];
    for (const recipient of stableRecipients) {
      envelopes.push(await seal(material, keyCommitmentSha256, {
        ...stableIdentity, recipientDeviceId: recipient.deviceId,
      }, recipient.publicKey));
    }
    return { key: await importVaultKey(material), keyCommitmentSha256, envelopes };
  } catch { throw new ScopeKeyEnvelopeV2Error(); }
  finally { material.fill(0); }
}

/** Caller supplies a trusted registered identity, commitment and recipient. */
export async function openScopeKeyEnvelopeV2(expected: ExpectedScopeKeyV2,
  envelope: ScopeKeyEnvelopeV2, recipient: CryptoKeyPair): Promise<CryptoKey> {
  let material: Uint8Array | null = null;
  try {
    assertExpected(expected);
    const stableExpected = { ...expected };
    assertScopeKeyEnvelopeV2(envelope);
    const stable = snapshotEnvelope(envelope);
    const publicKey = recipient.publicKey;
    const privateKey = recipient.privateKey;
    assertPublicKey(publicKey);
    assertPrivateKey(privateKey);
    if (!sameContext(stableExpected, stable.context) ||
      stableExpected.keyCommitmentSha256 !== stable.keyCommitmentSha256)
      throw new ScopeKeyEnvelopeV2Error();
    const recipientRaw = new Uint8Array(await suite.kem.serializePublicKey(
      publicKey));
    if (await sha256Hex(recipientRaw) !== stable.recipientKeySha256)
      throw new ScopeKeyEnvelopeV2Error();
    const context = await suite.createRecipientContext({
      recipientKey: { publicKey, privateKey },
      enc: toArrayBuffer(stable.encapsulatedKey),
      info: hpkeInfo(stable.context.purpose) });
    material = new Uint8Array(await context.open(stable.ciphertext,
      toArrayBuffer(encodeScopeKeyHeaderV2(stable))));
    if (material.byteLength !== KEY_BYTES ||
      await scopeKeyCommitmentSha256(material) !== stableExpected.keyCommitmentSha256)
      throw new ScopeKeyEnvelopeV2Error();
    return await importVaultKey(material);
  } catch { throw new ScopeKeyEnvelopeV2Error(); }
  finally { material?.fill(0); }
}

function snapshotEnvelope(envelope: ScopeKeyEnvelopeV2): ScopeKeyEnvelopeV2 {
  const { householdId, careProfileId, opaqueScopeId, keyId, keyEpoch,
    purpose, recipientDeviceId } = envelope.context;
  return { format: SCOPE_KEY_ENVELOPE_FORMAT_V2,
    context: { householdId, careProfileId, opaqueScopeId, keyId, keyEpoch,
      purpose, recipientDeviceId },
    keyCommitmentSha256: envelope.keyCommitmentSha256,
    recipientKeySha256: envelope.recipientKeySha256,
    encapsulatedKey: envelope.encapsulatedKey.slice(),
    ciphertext: envelope.ciphertext.slice(0) };
}

async function seal(material: Uint8Array, keyCommitmentSha256: string,
  context: ScopeKeyContextV2, recipientPublicKey: CryptoKey):
  Promise<ScopeKeyEnvelopeV2> {
  const recipientRaw = new Uint8Array(await suite.kem.serializePublicKey(
    recipientPublicKey));
  const sender = await suite.createSenderContext({ recipientPublicKey,
    info: hpkeInfo(context.purpose) });
  const envelope: ScopeKeyEnvelopeV2 = {
    format: SCOPE_KEY_ENVELOPE_FORMAT_V2, context, keyCommitmentSha256,
    recipientKeySha256: await sha256Hex(recipientRaw),
    encapsulatedKey: new Uint8Array(sender.enc),
    ciphertext: new ArrayBuffer(0),
  };
  const plaintext = toArrayBuffer(material);
  try {
    envelope.ciphertext = await sender.seal(plaintext,
      toArrayBuffer(encodeScopeKeyHeaderV2(envelope)));
  } finally { new Uint8Array(plaintext).fill(0); }
  return envelope;
}

/** Stable material-only commitment for signed key registration, not authority. */
export async function scopeKeyCommitmentSha256(material: Uint8Array): Promise<string> {
  if (!(material instanceof Uint8Array) || material.byteLength !== KEY_BYTES)
    throw new ScopeKeyEnvelopeV2Error();
  const stable = Uint8Array.from(material);
  const bytes = new Uint8Array(COMMITMENT_DOMAIN.byteLength + KEY_BYTES);
  bytes.set(COMMITMENT_DOMAIN);
  bytes.set(stable, COMMITMENT_DOMAIN.byteLength);
  try { return await sha256Hex(bytes); }
  finally { bytes.fill(0); stable.fill(0); }
}

function hpkeInfo(purpose: ScopeKeyPurposeV2): Uint8Array {
  return new TextEncoder().encode(`adeno:managed:scope-key-envelope:v2:${purpose}\0`);
}

function assertIdentity(identity: ScopeKeyIdentityV2): void {
  if (!identity || !hasOnlyKeys(identity, IDENTITY_KEYS))
    throw new ScopeKeyEnvelopeV2Error();
  for (const id of [identity.householdId, identity.careProfileId,
    identity.opaqueScopeId, identity.keyId]) assertOpaqueId(id);
  if (!Number.isSafeInteger(identity.keyEpoch) || identity.keyEpoch < 1 ||
    identity.keyEpoch > 0xffffffff ||
    !["day", "source", "draft", "index"].includes(identity.purpose))
    throw new ScopeKeyEnvelopeV2Error();
}

function assertExpected(expected: ExpectedScopeKeyV2): void {
  if (!expected || !hasOnlyKeys(expected, [...CONTEXT_KEYS,
    "keyCommitmentSha256"])) throw new ScopeKeyEnvelopeV2Error();
  const { keyCommitmentSha256, recipientDeviceId, ...identity } = expected;
  assertIdentity(identity);
  assertOpaqueId(recipientDeviceId);
  if (typeof keyCommitmentSha256 !== "string" ||
    !SHA256.test(keyCommitmentSha256)) throw new ScopeKeyEnvelopeV2Error();
}

function sameContext(a: ScopeKeyContextV2, b: ScopeKeyContextV2): boolean {
  return a.householdId === b.householdId &&
    a.careProfileId === b.careProfileId &&
    a.opaqueScopeId === b.opaqueScopeId && a.keyId === b.keyId &&
    a.keyEpoch === b.keyEpoch && a.purpose === b.purpose &&
    a.recipientDeviceId === b.recipientDeviceId;
}

function assertOpaqueId(value: string): void {
  if (typeof value !== "string" || !OPAQUE_ID.test(value))
    throw new ScopeKeyEnvelopeV2Error();
}

function assertPublicKey(key: CryptoKey): void {
  if (!key || key.type !== "public" || key.algorithm.name !== "X25519")
    throw new ScopeKeyEnvelopeV2Error();
}

function assertPrivateKey(key: CryptoKey): void {
  if (!key || key.type !== "private" || key.algorithm.name !== "X25519" ||
    key.extractable || !key.usages.includes("deriveBits"))
    throw new ScopeKeyEnvelopeV2Error();
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let value = "";
  for (const byte of digest) value += byte.toString(16).padStart(2, "0");
  return value;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}
