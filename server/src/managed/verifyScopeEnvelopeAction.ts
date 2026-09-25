import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import { decodeScopeKeyEnvelopeV2, encodeScopeEnvelopeActionPayloadV1,
  SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1,
  type ScopeKeyPurposeV2 } from "@adeno/contracts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;

export class ScopeEnvelopeActionDeniedError extends Error {
  constructor() {
    super("The signed scope-key envelope binding is invalid.");
    this.name = "ScopeEnvelopeActionDeniedError";
  }
}

export type ScopeEnvelopeRowCandidate = {
  householdId: string;
  careProfileId: string;
  opaqueScopeId: string;
  keyId: string;
  keyEpoch: number;
  purpose: ScopeKeyPurposeV2;
  recipientDeviceId: string;
  keyCommitmentSha256: string;
  recipientKeySha256: string;
  wireVersion: 2;
  wire: Uint8Array;
  wireSha256: string;
  activeKeyHeadSha256: string;
  grantHeadSha256: string;
  signedPayloadSha256: string;
  issuerDeviceId: string;
  issuerCounter: bigint;
  sessionId: string;
  createdAt: bigint;
};

export type SignedScopeEnvelopeActionRow = {
  householdId: string;
  deviceId: string;
  counter: bigint;
  actionKind: string;
  payloadSha256: string;
  previousActionSha256: string | null;
  actionSha256: string;
  signature: Uint8Array;
  createdAt: bigint;
};

/**
 * Pure cryptographic/binding check, NOT authorization or read access.
 * The future writer must load enrolled keys, exact device IDs, predecessor,
 * current heads and active owner/recipient grants from the SAME write
 * transaction, then insert action and envelope atomically. A prior signed
 * head cannot prove that a server revealed its latest state to the client.
 */
export function verifyScopeEnvelopeAction(input: {
  row: ScopeEnvelopeRowCandidate;
  action: SignedScopeEnvelopeActionRow;
  enrolledIssuerSigningPublicKey: Uint8Array;
  enrolledRecipientEncryptionPublicKey: Uint8Array;
  currentActiveKeyHeadSha256: string;
  currentGrantHeadSha256: string;
  expectedPreviousActionSha256: string | null;
  authenticatedSessionId: string;
  authenticatedIssuerDeviceId: string;
}): void {
  try {
    const row = input.row;
    const action = input.action;
    const wire = copyBytes(row.wire, 240);
    const signature = copyBytes(action.signature, 64);
    const issuerKey = copyBytes(input.enrolledIssuerSigningPublicKey, 32);
    const recipientKey = copyBytes(input.enrolledRecipientEncryptionPublicKey, 32);
    const envelope = decodeScopeKeyEnvelopeV2(wire);
    const context = envelope.context;
    const recipientKeySha256 = sha256(recipientKey);
    if (row.wireVersion !== 2 ||
      row.householdId !== context.householdId ||
      row.careProfileId !== context.careProfileId ||
      row.opaqueScopeId !== context.opaqueScopeId ||
      row.keyId !== context.keyId || row.keyEpoch !== context.keyEpoch ||
      row.purpose !== context.purpose ||
      row.recipientDeviceId !== context.recipientDeviceId ||
      row.keyCommitmentSha256 !== envelope.keyCommitmentSha256 ||
      row.recipientKeySha256 !== envelope.recipientKeySha256 ||
      row.recipientKeySha256 !== recipientKeySha256 ||
      row.wireSha256 !== sha256(wire) ||
      row.activeKeyHeadSha256 !== input.currentActiveKeyHeadSha256 ||
      row.grantHeadSha256 !== input.currentGrantHeadSha256 ||
      row.sessionId !== input.authenticatedSessionId ||
      row.issuerDeviceId !== input.authenticatedIssuerDeviceId ||
      row.householdId !== action.householdId ||
      row.issuerDeviceId !== action.deviceId ||
      row.issuerCounter !== action.counter ||
      action.actionKind !== "envelope" ||
      row.createdAt !== action.createdAt ||
      action.previousActionSha256 !== input.expectedPreviousActionSha256)
      throw new ScopeEnvelopeActionDeniedError();
    const payload = encodeScopeEnvelopeActionPayloadV1({
      ...context,
      keyCommitmentSha256: row.keyCommitmentSha256,
      recipientKeySha256,
      wireSha256: row.wireSha256,
      activeKeyHeadSha256: row.activeKeyHeadSha256,
      grantHeadSha256: row.grantHeadSha256,
      issuerDeviceId: row.issuerDeviceId,
      issuerCounter: row.issuerCounter,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      previousActionSha256: action.previousActionSha256,
      issuerSigningKeySha256: sha256(issuerKey),
    });
    const payloadSha256 = sha256(payload);
    if (row.signedPayloadSha256 !== payloadSha256 ||
      action.payloadSha256 !== payloadSha256 ||
      action.actionSha256 !== sha256(Buffer.concat([
        Buffer.from(SCOPE_ENVELOPE_ACTION_HASH_DOMAIN_V1),
        Buffer.from(payload), Buffer.from(signature),
      ]))) throw new ScopeEnvelopeActionDeniedError();
    const key = createPublicKey({ key: Buffer.concat([
      ED25519_SPKI_PREFIX, Buffer.from(issuerKey),
    ]), format: "der", type: "spki" });
    if (!verifySignature(null, Buffer.from(payload), key, Buffer.from(signature)))
      throw new ScopeEnvelopeActionDeniedError();
  } catch { throw new ScopeEnvelopeActionDeniedError(); }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" ||
    value.byteLength !== length) throw new ScopeEnvelopeActionDeniedError();
  return Uint8Array.from(value);
}
