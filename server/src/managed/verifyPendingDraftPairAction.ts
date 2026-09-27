import { createHash, createPublicKey, verify as verifySignature } from
  "node:crypto";

import { encodePendingDraftPairActionPayloadV1,
  PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1,
  type PendingDraftPairActionContextV1 } from "@adeno/contracts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BYTE_TAG = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get;
const STATE_FIELDS = ["householdId", "careProfileId",
  "opaqueDraftScopeId", "keyId", "reservationId", "contentIntentId",
  "metadataIntentId", "contentBlobId", "metadataBlobId",
  "contentObjectId", "metadataObjectId", "authorDeviceId", "sessionId",
  "keyEpoch", "contentWireBytes", "metadataWireBytes",
  "keyCommitmentSha256", "activeKeyHeadSha256", "grantHeadSha256",
  "contentWireSha256", "metadataWireSha256"] as const;

type PairState = Pick<PendingDraftPairActionContextV1,
  typeof STATE_FIELDS[number]>;

export type SignedPendingDraftPairActionRow = {
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

export class PendingDraftPairActionDenied extends Error {
  constructor() {
    super("The signed pending draft pair is invalid.");
    this.name = "PendingDraftPairActionDenied";
  }
}

/**
 * Pure signature and state-binding check, not database authorization.
 * A future unmounted writer must load `current` from reservation, exact two
 * committed blobs/intents, live session-device binding, current key/grant and
 * signer enrollment in ONE BEGIN IMMEDIATE transaction, then insert the
 * signed action and pending pair atomically. This function does not decrypt
 * metadata or approve/publish a care day.
 */
export function verifyPendingDraftPairAction(input: {
  context: PendingDraftPairActionContextV1;
  pairSha256: string;
  action: SignedPendingDraftPairActionRow;
  current: PairState;
  enrolledAuthorSigningPublicKey: Uint8Array;
  expectedCounter: bigint;
  expectedPreviousActionSha256: string | null;
  authenticatedSessionId: string;
  authenticatedAuthorDeviceId: string;
  nowUnixSeconds: bigint;
}): void {
  try {
    const context = { ...input.context };
    const action = input.action;
    const signature = copyBytes(action.signature, 64);
    const signerKey = copyBytes(input.enrolledAuthorSigningPublicKey, 32);
    if (STATE_FIELDS.some((field) => context[field] !== input.current[field]) ||
      context.authorCounter !== input.expectedCounter ||
      context.previousActionSha256 !==
        input.expectedPreviousActionSha256 ||
      context.sessionId !== input.authenticatedSessionId ||
      context.authorDeviceId !== input.authenticatedAuthorDeviceId ||
      context.pairedAt < input.nowUnixSeconds - 5n ||
      context.pairedAt > input.nowUnixSeconds + 5n ||
      context.issuerSigningKeySha256 !== sha256(signerKey) ||
      action.householdId !== context.householdId ||
      action.deviceId !== context.authorDeviceId ||
      action.counter !== context.authorCounter ||
      action.actionKind !== "review" ||
      action.previousActionSha256 !== context.previousActionSha256 ||
      action.createdAt !== context.pairedAt)
      throw new PendingDraftPairActionDenied();
    const payload = encodePendingDraftPairActionPayloadV1(context);
    const payloadSha256 = sha256(payload);
    if (input.pairSha256 !== payloadSha256 ||
      action.payloadSha256 !== payloadSha256 ||
      action.actionSha256 !== sha256(Buffer.concat([
        Buffer.from(PENDING_DRAFT_PAIR_ACTION_HASH_DOMAIN_V1),
        Buffer.from(payload), Buffer.from(signature),
      ]))) throw new PendingDraftPairActionDenied();
    const key = createPublicKey({ key: Buffer.concat([
      ED25519_SPKI_PREFIX, Buffer.from(signerKey),
    ]), format: "der", type: "spki" });
    if (!verifySignature(null, Buffer.from(payload), key,
      Buffer.from(signature))) throw new PendingDraftPairActionDenied();
  } catch { throw new PendingDraftPairActionDenied(); }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyBytes(value: Uint8Array, length: number): Uint8Array {
  if (!ArrayBuffer.isView(value) || !BYTE_TAG ||
    BYTE_TAG.call(value) !== "Uint8Array" || value.byteLength !== length)
    throw new PendingDraftPairActionDenied();
  return Uint8Array.from(value);
}
