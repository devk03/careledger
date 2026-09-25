import { importVaultKey } from "./vault";

export const DAY_KEY_ENVELOPE_FORMAT = "adeno.day-key-envelope.v1" as const;
const DAY_KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECIPIENTS = 32;
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const IDENTITY_KEYS = ["careProfileId", "householdId", "keyEpoch", "opaqueDayId"];
const CONTEXT_KEYS = [...IDENTITY_KEYS, "recipientDeviceId"];
const ENVELOPE_KEYS = ["ciphertext", "context", "ephemeralSpki", "format",
  "iv", "recipientKeySha256", "salt"];

export type DayKeyIdentity = {
  householdId: string;
  careProfileId: string;
  opaqueDayId: string;
  keyEpoch: number;
};

export type DayKeyContext = DayKeyIdentity & { recipientDeviceId: string };

export type DayKeyEnvelope = {
  format: typeof DAY_KEY_ENVELOPE_FORMAT;
  context: DayKeyContext;
  recipientKeySha256: string;
  ephemeralSpki: Uint8Array;
  salt: Uint8Array;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
};

export class DayKeyEnvelopeError extends Error {
  constructor() {
    super("This care-day key could not be verified or opened.");
    this.name = "DayKeyEnvelopeError";
  }
}

/** Prototype only: device public keys still need an authenticated enrollment path. */
export async function generateDeviceEncryptionKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
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
    assertEnvelope(envelope);
    const stable = snapshotEnvelope(envelope);
    const publicKey = recipient.publicKey;
    const privateKey = recipient.privateKey;
    assertPublicKey(publicKey);
    assertPrivateKey(privateKey);
    if (!sameContext(expected, stable.context)) throw new DayKeyEnvelopeError();
    const recipientSpki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
    if (await sha256Hex(recipientSpki) !== stable.recipientKeySha256)
      throw new DayKeyEnvelopeError();
    const ephemeral = await crypto.subtle.importKey("spki", stable.ephemeralSpki,
      { name: "ECDH", namedCurve: "P-256" }, false, []);
    const aad = associatedData(stable);
    const wrappingKey = await wrappingKeyFor(privateKey, ephemeral,
      stable.salt, aad);
    material = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: stable.iv, additionalData: aad, tagLength: 128 },
      wrappingKey, stable.ciphertext));
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
    ephemeralSpki: envelope.ephemeralSpki.slice(), salt: envelope.salt.slice(),
    iv: envelope.iv.slice(), ciphertext: envelope.ciphertext.slice(0) };
}

async function sealDayKeyMaterial(material: Uint8Array, context: DayKeyContext,
  recipientPublicKey: CryptoKey): Promise<DayKeyEnvelope> {
  const recipientSpki = new Uint8Array(await crypto.subtle.exportKey("spki", recipientPublicKey));
  const ephemeral = await generateDeviceEncryptionKeys();
  const envelope: DayKeyEnvelope = {
    format: DAY_KEY_ENVELOPE_FORMAT,
    context,
    recipientKeySha256: await sha256Hex(recipientSpki),
    ephemeralSpki: new Uint8Array(await crypto.subtle.exportKey("spki", ephemeral.publicKey)),
    salt: crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
    iv: crypto.getRandomValues(new Uint8Array(IV_BYTES)),
    ciphertext: new ArrayBuffer(0),
  };
  const aad = associatedData(envelope);
  const wrappingKey = await wrappingKeyFor(ephemeral.privateKey, recipientPublicKey,
    envelope.salt, aad);
  envelope.ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: envelope.iv, additionalData: aad, tagLength: 128 },
    wrappingKey, material);
  return envelope;
}

async function wrappingKeyFor(privateKey: CryptoKey, publicKey: CryptoKey,
  salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: publicKey }, privateKey, 256));
  try {
    const keyMaterial = await crypto.subtle.importKey("raw", shared, "HKDF", false,
      ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info }, keyMaterial,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    shared.fill(0);
  }
}

function associatedData(envelope: DayKeyEnvelope): Uint8Array {
  const { householdId, careProfileId, opaqueDayId, keyEpoch, recipientDeviceId } = envelope.context;
  return new TextEncoder().encode(JSON.stringify({
    format: DAY_KEY_ENVELOPE_FORMAT, purpose: "day-content",
    householdId, careProfileId, opaqueDayId, keyEpoch, recipientDeviceId,
    recipientKeySha256: envelope.recipientKeySha256,
    ephemeralSpki: hex(envelope.ephemeralSpki), salt: hex(envelope.salt),
  }));
}

function assertEnvelope(envelope: DayKeyEnvelope): void {
  if (!envelope || envelope.format !== DAY_KEY_ENVELOPE_FORMAT ||
    !hasOnlyKeys(envelope, ENVELOPE_KEYS) ||
    !envelope.context || !FINGERPRINT.test(envelope.recipientKeySha256) ||
    !(envelope.ephemeralSpki instanceof Uint8Array) ||
    envelope.ephemeralSpki.byteLength < 80 || envelope.ephemeralSpki.byteLength > 128 ||
    !(envelope.salt instanceof Uint8Array) || envelope.salt.byteLength !== SALT_BYTES ||
    !(envelope.iv instanceof Uint8Array) || envelope.iv.byteLength !== IV_BYTES ||
    Object.prototype.toString.call(envelope.ciphertext) !== "[object ArrayBuffer]" ||
    envelope.ciphertext.byteLength !== DAY_KEY_BYTES + TAG_BYTES)
    throw new DayKeyEnvelopeError();
  assertContext(envelope.context);
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
  if (!key || key.type !== "public" || key.algorithm.name !== "ECDH" ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256")
    throw new DayKeyEnvelopeError();
}

function assertPrivateKey(key: CryptoKey): void {
  if (!key || key.type !== "private" || key.algorithm.name !== "ECDH" ||
    (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" ||
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
