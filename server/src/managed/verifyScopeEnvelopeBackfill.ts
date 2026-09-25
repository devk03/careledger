import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import { decodeScopeKeyEnvelopeV2, encodeScopeEnvelopeBackfillPayloadV1,
  SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1,
  type ScopeKeyPurposeV2 } from "@adeno/contracts";

import type { SignedScopeEnvelopeActionRow } from "./verifyScopeEnvelopeAction.js";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;

export class ScopeEnvelopeBackfillDeniedError extends Error {
  constructor() {
    super("The historical scope-key action binding is invalid.");
    this.name = "ScopeEnvelopeBackfillDeniedError";
  }
}

export type ScopeEnvelopeBackfillRowCandidate = {
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
  historicalActivationSequence: bigint;
  historicalActivationSha256: string;
  currentActiveKeySequence: bigint;
  currentActiveKeyHeadSha256: string;
  currentGrantSequence: bigint;
  currentGrantHeadSha256: string;
  signedPayloadSha256: string;
  issuerDeviceId: string;
  issuerCounter: bigint;
  sessionId: string;
  createdAt: bigint;
};

/**
 * Cryptographic and database-state binding only; it is NOT a grant check.
 * A future writer must obtain all expected values from one immediate SQLite
 * transaction, check current owner/recipient/session/grant, then insert the
 * action and backfill atomically. The client still needs a freshness witness.
 */
export function verifyScopeEnvelopeBackfill(input: {
  row: ScopeEnvelopeBackfillRowCandidate;
  action: SignedScopeEnvelopeActionRow;
  enrolledIssuerSigningPublicKey: Uint8Array;
  enrolledRecipientEncryptionPublicKey: Uint8Array;
  historicalActivationSequence: bigint;
  historicalActivationSha256: string;
  currentActiveKeySequence: bigint;
  currentActiveKeyEpoch: number;
  currentActiveKeyHeadSha256: string;
  currentGrantSequence: bigint;
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
      row.historicalActivationSequence !== input.historicalActivationSequence ||
      row.historicalActivationSha256 !== input.historicalActivationSha256 ||
      row.currentActiveKeySequence !== input.currentActiveKeySequence ||
      row.currentActiveKeyHeadSha256 !== input.currentActiveKeyHeadSha256 ||
      row.currentGrantSequence !== input.currentGrantSequence ||
      row.currentGrantHeadSha256 !== input.currentGrantHeadSha256 ||
      !Number.isSafeInteger(input.currentActiveKeyEpoch) ||
      input.currentActiveKeyEpoch < 1 ||
      input.currentActiveKeyEpoch > 0xffffffff ||
      row.keyEpoch >= input.currentActiveKeyEpoch ||
      row.sessionId !== input.authenticatedSessionId ||
      row.issuerDeviceId !== input.authenticatedIssuerDeviceId ||
      row.householdId !== action.householdId ||
      row.issuerDeviceId !== action.deviceId ||
      row.issuerCounter !== action.counter ||
      action.actionKind !== "envelope" ||
      row.createdAt !== action.createdAt ||
      action.previousActionSha256 !== input.expectedPreviousActionSha256)
      throw new ScopeEnvelopeBackfillDeniedError();
    const payload = encodeScopeEnvelopeBackfillPayloadV1({
      ...context,
      keyCommitmentSha256: row.keyCommitmentSha256,
      recipientKeySha256,
      wireSha256: row.wireSha256,
      historicalActivationSequence: row.historicalActivationSequence,
      historicalActivationSha256: row.historicalActivationSha256,
      currentActiveKeySequence: row.currentActiveKeySequence,
      activeKeyHeadSha256: row.currentActiveKeyHeadSha256,
      currentGrantSequence: row.currentGrantSequence,
      grantHeadSha256: row.currentGrantHeadSha256,
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
        Buffer.from(SCOPE_ENVELOPE_BACKFILL_HASH_DOMAIN_V1),
        Buffer.from(payload), Buffer.from(signature),
      ]))) throw new ScopeEnvelopeBackfillDeniedError();
    const key = createPublicKey({ key: Buffer.concat([
      ED25519_SPKI_PREFIX, Buffer.from(issuerKey),
    ]), format: "der", type: "spki" });
    if (!verifySignature(null, Buffer.from(payload), key, Buffer.from(signature)))
      throw new ScopeEnvelopeBackfillDeniedError();
  } catch { throw new ScopeEnvelopeBackfillDeniedError(); }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" || value.byteLength !== length)
    throw new ScopeEnvelopeBackfillDeniedError();
  return Uint8Array.from(value);
}
