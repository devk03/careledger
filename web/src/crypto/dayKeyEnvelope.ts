import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { DAY_KEY_ENVELOPE_FORMAT, assertDayKeyEnvelopeShape, encodeDayKeyHeader,
  type DayKeyContext, type DayKeyEnvelope, type DayKeyIdentity } from "@adeno/contracts";

import { importVaultKey } from "./vault";

export { DAY_KEY_ENVELOPE_FORMAT } from "@adeno/contracts";
export type { DayKeyContext, DayKeyEnvelope, DayKeyIdentity } from "@adeno/contracts";
const DAY_KEY_BYTES = 32;
const MAX_RECIPIENTS = 32;
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const HPKE_INFO = new TextEncoder().encode(
  "adeno:day-content:hpke-x25519-hkdf-sha256-aes256gcm-v1",
);
const IDENTITY_KEYS = ["careProfileId", "householdId", "keyEpoch", "opaqueDayId"];
const CONTEXT_KEYS = [...IDENTITY_KEYS, "recipientDeviceId"];
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(), aead: new Aes256Gcm() });

export class DayKeyEnvelopeError extends Error {
  constructor() {
    super("This care-day key could not be verified or opened.");
    this.name = "DayKeyEnvelopeError";
  }
}

/** Prototype only: device public keys still need an authenticated enrollment path. */
export async function generateDeviceEncryptionKeys(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  if (!("privateKey" in pair)) throw new DayKeyEnvelopeError();
  return pair;
}

/** Browser-only prototype. Never upload raw day material or share an owner recovery root. */
export async function createDayKeyEnvelopes(
  identity: DayKeyIdentity,
  recipients: readonly { deviceId: string; publicKey: CryptoKey }[],
): Promise<{ key: CryptoKey; envelopes: DayKeyEnvelope[] }> {
  assertIdentity(identity);
  if (!Array.isArray(recipients) || recipients.length < 1 ||
    recipients.length > MAX_RECIPIENTS)
    throw new DayKeyEnvelopeError();
  const stableIdentity = { householdId: identity.householdId,
    careProfileId: identity.careProfileId, opaqueDayId: identity.opaqueDayId,
    keyEpoch: identity.keyEpoch };
  const stableRecipients = recipients.map((recipient) => {
    assertOpaqueId(recipient.deviceId);
    assertPublicKey(recipient.publicKey);
    return { deviceId: recipient.deviceId, publicKey: recipient.publicKey };
  });
  if (new Set(stableRecipients.map(({ deviceId }) => deviceId)).size !== stableRecipients.length)
    throw new DayKeyEnvelopeError();
  const material = crypto.getRandomValues(new Uint8Array(DAY_KEY_BYTES));
  try {
    const envelopes: DayKeyEnvelope[] = [];
    for (const recipient of stableRecipients) {
      envelopes.push(await sealDayKeyMaterial(material, {
        ...stableIdentity,
        recipientDeviceId: recipient.deviceId,
      }, recipient.publicKey));
    }
    return { key: await importVaultKey(material), envelopes };
  } catch {
    throw new DayKeyEnvelopeError();
  } finally {
    material.fill(0);
  }
}

/** A returned key is non-exportable. The envelope alone does not prove a grant or sender. */
export async function openDayKeyEnvelope(
  expected: DayKeyContext,
  envelope: DayKeyEnvelope,
  recipient: CryptoKeyPair,
): Promise<CryptoKey> {
  let material: Uint8Array | null = null;
  try {
    assertContext(expected);
    assertDayKeyEnvelopeShape(envelope);
    const stable = snapshotEnvelope(envelope);
    const publicKey = recipient.publicKey;
    const privateKey = recipient.privateKey;
    assertPublicKey(publicKey);
    assertPrivateKey(privateKey);
    if (!sameContext(expected, stable.context)) throw new DayKeyEnvelopeError();
    const recipientRaw = new Uint8Array(await suite.kem.serializePublicKey(publicKey));
    if (await sha256Hex(recipientRaw) !== stable.recipientKeySha256)
      throw new DayKeyEnvelopeError();
    const recipientContext = await suite.createRecipientContext({ recipientKey: { publicKey, privateKey },
      enc: toArrayBuffer(stable.encapsulatedKey), info: HPKE_INFO });
    material = new Uint8Array(await recipientContext.open(stable.ciphertext,
      toArrayBuffer(encodeDayKeyHeader(stable))));
    if (material.byteLength !== DAY_KEY_BYTES) throw new DayKeyEnvelopeError();
    return await importVaultKey(material);
  } catch {
    throw new DayKeyEnvelopeError();
  } finally {
    material?.fill(0);
  }
}

function snapshotEnvelope(envelope: DayKeyEnvelope): DayKeyEnvelope {
  const { householdId, careProfileId, opaqueDayId, keyEpoch, recipientDeviceId } = envelope.context;
  return { format: DAY_KEY_ENVELOPE_FORMAT,
    context: { householdId, careProfileId, opaqueDayId, keyEpoch, recipientDeviceId },
    recipientKeySha256: envelope.recipientKeySha256,
    encapsulatedKey: envelope.encapsulatedKey.slice(),
    ciphertext: envelope.ciphertext.slice(0) };
}

async function sealDayKeyMaterial(material: Uint8Array, context: DayKeyContext,
  recipientPublicKey: CryptoKey): Promise<DayKeyEnvelope> {
  const recipientRaw = new Uint8Array(await suite.kem.serializePublicKey(recipientPublicKey));
  const sender = await suite.createSenderContext({ recipientPublicKey, info: HPKE_INFO });
  const envelope: DayKeyEnvelope = {
    format: DAY_KEY_ENVELOPE_FORMAT,
    context,
    recipientKeySha256: await sha256Hex(recipientRaw),
    encapsulatedKey: new Uint8Array(sender.enc),
    ciphertext: new ArrayBuffer(0),
  };
  const plaintext = toArrayBuffer(material);
  try {
    envelope.ciphertext = await sender.seal(plaintext,
      toArrayBuffer(encodeDayKeyHeader(envelope)));
  } finally {
    new Uint8Array(plaintext).fill(0);
  }
  return envelope;
}

function assertIdentity(identity: DayKeyIdentity): void {
  if (!identity || !hasOnlyKeys(identity, IDENTITY_KEYS)) throw new DayKeyEnvelopeError();
  assertIdentityFields(identity);
}

function assertIdentityFields(identity: DayKeyIdentity): void {
  assertOpaqueId(identity.householdId);
  assertOpaqueId(identity.careProfileId);
  assertOpaqueId(identity.opaqueDayId);
  if (!Number.isSafeInteger(identity.keyEpoch) || identity.keyEpoch < 1 ||
    identity.keyEpoch > 0xffffffff) throw new DayKeyEnvelopeError();
}

function assertContext(context: DayKeyContext): void {
  if (!context || !hasOnlyKeys(context, CONTEXT_KEYS)) throw new DayKeyEnvelopeError();
  assertIdentityFields(context);
  assertOpaqueId(context.recipientDeviceId);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function assertOpaqueId(value: string): void {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new DayKeyEnvelopeError();
}

function assertPublicKey(key: CryptoKey): void {
  if (!key || key.type !== "public" || key.algorithm.name !== "X25519")
    throw new DayKeyEnvelopeError();
}

function assertPrivateKey(key: CryptoKey): void {
  if (!key || key.type !== "private" || key.algorithm.name !== "X25519" ||
    key.extractable || !key.usages.includes("deriveBits"))
    throw new DayKeyEnvelopeError();
}

function sameContext(a: DayKeyContext, b: DayKeyContext): boolean {
  return a.householdId === b.householdId && a.careProfileId === b.careProfileId &&
    a.opaqueDayId === b.opaqueDayId && a.keyEpoch === b.keyEpoch &&
    a.recipientDeviceId === b.recipientDeviceId;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(value);
  return copy;
}
