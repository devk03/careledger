import sodium from "libsodium-wrappers-sumo";

import { generateVaultKeyMaterial, importVaultKey } from "./vault";

export const RECOVERY_FORMAT = "careledger.recovery.v1" as const;
export const RECOVERY_KDF_PROFILE = "argon2id-19mib-2-v1" as const;
const ARGON2_MEMORY_BYTES = 19 * 1024 * 1024;
const ARGON2_OPERATIONS = 2;
const RECOVERY_KEY_BYTES = 32;
const SALT_BYTES = 16;
const ENVELOPE_ID_BYTES = 16;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const RECOVERY_CHECKSUM_BYTES = 4;
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface RecoveryEnvelope {
  format: typeof RECOVERY_FORMAT;
  kdfProfile: typeof RECOVERY_KDF_PROFILE;
  salt: Uint8Array;
  envelopeId: Uint8Array;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface RecoverableVault {
  key: CryptoKey;
  envelope: RecoveryEnvelope;
  recoveryCode: string;
}

export class RecoveryError extends Error {
  constructor() {
    super("Adeno could not open this recovery kit.");
    this.name = "RecoveryError";
  }
}

export async function createRecoverableVault(
  householdId: string,
): Promise<RecoverableVault> {
  assertHouseholdId(householdId);
  const generated = await generateRecoveryCode();
  const recoverySecretBytes = generated.secretBytes;
  const vaultMaterial = generateVaultKeyMaterial();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const envelopeId = crypto.getRandomValues(new Uint8Array(ENVELOPE_ID_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  let wrappingMaterial: Uint8Array | null = null;
  try {
    wrappingMaterial = await deriveWrappingMaterial(recoverySecretBytes, salt);
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      wrappingMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: recoveryAssociatedData(householdId, salt, envelopeId),
        tagLength: 128,
      },
      wrappingKey,
      vaultMaterial,
    );
    const key = await importVaultKey(vaultMaterial);
    return {
      key,
      recoveryCode: generated.code,
      envelope: {
        format: RECOVERY_FORMAT,
        kdfProfile: RECOVERY_KDF_PROFILE,
        salt,
        envelopeId,
        iv,
        ciphertext,
      },
    };
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError();
  } finally {
    vaultMaterial.fill(0);
    wrappingMaterial?.fill(0);
    recoverySecretBytes.fill(0);
  }
}

export async function recoverVault(
  recoveryCode: string,
  householdId: string,
  envelope: RecoveryEnvelope,
): Promise<CryptoKey> {
  let recoverySecretBytes: Uint8Array | null = null;
  let wrappingMaterial: Uint8Array | null = null;
  let vaultMaterial: Uint8Array | null = null;
  try {
    recoverySecretBytes = await parseRecoveryCode(recoveryCode);
    assertHouseholdId(householdId);
    assertEnvelope(envelope);
    wrappingMaterial = await deriveWrappingMaterial(recoverySecretBytes, envelope.salt);
    const wrappingKey = await crypto.subtle.importKey(
      "raw",
      wrappingMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    vaultMaterial = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: envelope.iv,
          additionalData: recoveryAssociatedData(
            householdId,
            envelope.salt,
            envelope.envelopeId,
          ),
          tagLength: 128,
        },
        wrappingKey,
        envelope.ciphertext,
      ),
    );
    if (vaultMaterial.byteLength !== RECOVERY_KEY_BYTES) throw new RecoveryError();
    return await importVaultKey(vaultMaterial);
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError();
  } finally {
    wrappingMaterial?.fill(0);
    vaultMaterial?.fill(0);
    recoverySecretBytes?.fill(0);
  }
}

async function deriveWrappingMaterial(
  recoverySecretBytes: Uint8Array,
  salt: Uint8Array,
): Promise<Uint8Array> {
  assertRecoverySecret(recoverySecretBytes);
  await sodium.ready;
  return sodium.crypto_pwhash(
    RECOVERY_KEY_BYTES,
    recoverySecretBytes,
    salt,
    ARGON2_OPERATIONS,
    ARGON2_MEMORY_BYTES,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
    "uint8array",
  );
}

function assertEnvelope(envelope: RecoveryEnvelope): void {
  if (
    envelope.format !== RECOVERY_FORMAT ||
    envelope.kdfProfile !== RECOVERY_KDF_PROFILE ||
    !isUint8Array(envelope.salt) ||
    envelope.salt.byteLength !== SALT_BYTES ||
    !isUint8Array(envelope.envelopeId) ||
    envelope.envelopeId.byteLength !== ENVELOPE_ID_BYTES ||
    !isUint8Array(envelope.iv) ||
    envelope.iv.byteLength !== GCM_IV_BYTES ||
    !isArrayBuffer(envelope.ciphertext) ||
    envelope.ciphertext.byteLength !== RECOVERY_KEY_BYTES + GCM_TAG_BYTES
  ) {
    throw new RecoveryError();
  }
}

function assertRecoverySecret(value: Uint8Array): void {
  if (!isUint8Array(value) || value.byteLength !== RECOVERY_KEY_BYTES) {
    throw new RecoveryError();
  }
}


async function generateRecoveryCode(): Promise<{
  code: string;
  secretBytes: Uint8Array;
}> {
  const secretBytes = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-256", secretBytes)).slice(
    0,
    RECOVERY_CHECKSUM_BYTES,
  );
  const packed = new Uint8Array(secretBytes.byteLength + checksum.byteLength);
  packed.set(secretBytes);
  packed.set(checksum, secretBytes.byteLength);
  const encoded = base32Encode(packed);
  packed.fill(0);
  checksum.fill(0);
  return {
    code: encoded.match(/.{1,4}/gu)?.join("-") ?? encoded,
    secretBytes,
  };
}


async function parseRecoveryCode(value: string): Promise<Uint8Array> {
  const normalized = value.replace(/[\s-]/gu, "").toUpperCase();
  const packed = base32Decode(normalized);
  if (packed.byteLength !== RECOVERY_KEY_BYTES + RECOVERY_CHECKSUM_BYTES) {
    packed.fill(0);
    throw new RecoveryError();
  }
  const secretBytes = packed.slice(0, RECOVERY_KEY_BYTES);
  const suppliedChecksum = packed.slice(RECOVERY_KEY_BYTES);
  const expectedChecksum = new Uint8Array(
    await crypto.subtle.digest("SHA-256", secretBytes),
  ).slice(0, RECOVERY_CHECKSUM_BYTES);
  let difference = 0;
  for (let index = 0; index < RECOVERY_CHECKSUM_BYTES; index += 1) {
    difference |= suppliedChecksum[index] ^ expectedChecksum[index];
  }
  packed.fill(0);
  suppliedChecksum.fill(0);
  expectedChecksum.fill(0);
  if (difference !== 0) {
    secretBytes.fill(0);
    throw new RecoveryError();
  }
  return secretBytes;
}


function base32Encode(value: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += RECOVERY_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += RECOVERY_ALPHABET[(buffer << (5 - bits)) & 31];
  return encoded;
}


function base32Decode(value: string): Uint8Array {
  let buffer = 0;
  let bits = 0;
  const decoded: number[] = [];
  for (const character of value) {
    const index = RECOVERY_ALPHABET.indexOf(character);
    if (index < 0) throw new RecoveryError();
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((buffer >>> bits) & 255);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new RecoveryError();
  return new Uint8Array(decoded);
}

function assertHouseholdId(value: string): void {
  if (!value || value.length > 256 || hasControlCharacter(value)) {
    throw new RecoveryError();
  }
}

function recoveryAssociatedData(
  householdId: string,
  salt: Uint8Array,
  envelopeId: Uint8Array,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      format: RECOVERY_FORMAT,
      kdfProfile: RECOVERY_KDF_PROFILE,
      householdId,
      salt: base64Url(salt),
      envelopeId: base64Url(envelopeId),
    }),
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]";
}
