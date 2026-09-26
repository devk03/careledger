import { decodeManagedVaultBlobV2, decodeSignedIndexHead,
  encodeManagedVaultBlobV2, INDEX_HEAD_WIRE_BYTES } from "@adeno/contracts";

import { decryptManagedVaultBlobV2, encryptManagedVaultBlobV2 } from
  "../crypto/managedVaultV2";
import { signLocalIndexHead, verifyIndexHeadCandidate, type IndexHeadCandidate,
  type IndexViewIdentity, type TrustedIndexCheckpoint } from
  "../crypto/signedIndexHead";
import { decryptedHistoryThroughDay, DecryptedTimelineChanged,
  projectDecryptedTimeline, type DecryptedHistoryCursor,
  type DecryptedHistoryPage, type DecryptedTimeline,
  type DecryptedTimelineEntry } from "./timeline";

const INDEX_FORMAT = "adeno.approved-history-index.v1";
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const MAX_INDEX_PLAINTEXT_BYTES = 4 * 1024 * 1024;
const MAX_INDEX_WIRE_BYTES = 33 + MAX_INDEX_PLAINTEXT_BYTES + 4 * 32;
const MAX_INDEX_ENTRIES = 10_000;

export class EncryptedIndexIntegrityError extends Error {
  constructor() { super("The encrypted timeline could not be verified or opened."); }
}

export type IndexedHistoryCursor = {
  headSha256: string;
  history: DecryptedHistoryCursor;
};

export type IndexedHistoryPage = Omit<DecryptedHistoryPage, "nextCursor"> & {
  headSha256: string;
  nextCursor: IndexedHistoryCursor | null;
};

export type OpenedLocalIndex = {
  state: "unchanged" | "advanced";
  /** Provisional until a separate current-grant and inventory proof is checked. */
  candidate: IndexHeadCandidate;
  timeline: DecryptedTimeline;
  historyThroughDay: (throughDay: string, input?: {
    cursor?: IndexedHistoryCursor; limit?: number;
  }) => Promise<IndexedHistoryPage>;
};

/**
 * Synchronous local payload encoder for caller-selected approved entries.
 * The caller must establish a complete authenticated current grant/review
 * inventory separately; this format cannot establish it by itself.
 */
export function encodeLocalApprovedIndex(input: {
  identity: IndexViewIdentity;
  objectId: string;
  sequence: bigint;
  entries: readonly DecryptedTimelineEntry[];
}): Uint8Array {
  try {
    const identity = snapshotIdentity(input.identity);
    if (!OPAQUE_ID.test(input.objectId) ||
      typeof input.sequence !== "bigint" || input.sequence < 1n ||
      input.sequence > 0xffffffffn) throw new EncryptedIndexIntegrityError();
    const entries = validateEntries(input.entries, identity.careProfileId);
    const payload = { format: INDEX_FORMAT,
      householdId: identity.householdId,
      careProfileId: identity.careProfileId, viewId: identity.viewId,
      indexKeyId: identity.indexKeyId, keyEpoch: identity.keyEpoch,
      objectId: input.objectId, sequence: input.sequence.toString(), entries };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    if (bytes.byteLength > MAX_INDEX_PLAINTEXT_BYTES)
      throw new EncryptedIndexIntegrityError();
    return bytes;
  } catch { throw new EncryptedIndexIntegrityError(); }
}

/**
 * Prepare one unpublished, device-encrypted index revision. A managed writer
 * must still verify a current grant, reserve the blob/nonce, and publish the
 * ciphertext plus signed head with compare-and-swap before trusting it.
 */
export async function sealLocalApprovedIndex(input: {
  identity: IndexViewIdentity;
  objectId: string;
  reservedBlobId: Uint8Array;
  entries: readonly DecryptedTimelineEntry[];
  indexKey: CryptoKey;
  authorDeviceId: string;
  authorCounter: bigint;
  grantHeadSha256: string;
  signingKeys: CryptoKeyPair;
  previous: TrustedIndexCheckpoint | null;
}): Promise<{ ciphertextWire: Uint8Array; signedHeadWire: Uint8Array;
  unpublishedCandidate: IndexHeadCandidate }> {
  let plaintext: Uint8Array | null = null;
  try {
    const identity = snapshotIdentity(input.identity);
    const previous = input.previous ? { ...input.previous } : null;
    const objectId = input.objectId;
    const authorDeviceId = input.authorDeviceId;
    const authorCounter = input.authorCounter;
    const grantHeadSha256 = input.grantHeadSha256;
    const signingKeys = { publicKey: input.signingKeys.publicKey,
      privateKey: input.signingKeys.privateKey };
    const sequence = previous ? previous.sequence + 1n : 1n;
    plaintext = encodeLocalApprovedIndex({ identity, objectId,
      sequence, entries: input.entries });
    const ciphertextWire = encodeManagedVaultBlobV2(
      await encryptManagedVaultBlobV2(input.indexKey, plaintext, {
        householdId: identity.householdId,
        careProfileId: identity.careProfileId,
        opaqueScopeId: identity.viewId, objectId,
        keyEpoch: identity.keyEpoch, purpose: "encrypted-index",
        revision: Number(sequence),
      }, input.reservedBlobId));
    const signed = await signLocalIndexHead({ identity,
      objectId, authorDeviceId, authorCounter,
      grantHeadSha256, ciphertextWire, signingKeys, previous });
    return { ciphertextWire, signedHeadWire: signed.wire,
      unpublishedCandidate: signed.candidate };
  } catch { throw new EncryptedIndexIntegrityError(); }
  finally { plaintext?.fill(0); }
}

/**
 * Device-only composition of pinned-head verification, exact AES-GCM scope,
 * canonical payload validation, and backward history projection. A trusted
 * checkpoint, signer, grant head, object ID and key must be established outside
 * this function. It does not prove current authorization, inventory completeness
 * or freshness to a new device; never mount it as a hosted plaintext route.
 */
export async function openLocalApprovedIndex(input: {
  signedHeadWire: Uint8Array;
  ciphertextWire: Uint8Array;
  expectedView: IndexViewIdentity;
  expectedObjectId: string;
  indexKey: CryptoKey;
  trustedSigner: { deviceId: string; publicKey: CryptoKey };
  trustedGrantHeadSha256: string;
  checkpoint: TrustedIndexCheckpoint;
}): Promise<OpenedLocalIndex> {
  let plaintext: Uint8Array | null = null;
  try {
    const headWire = boundedCopy(input.signedHeadWire, INDEX_HEAD_WIRE_BYTES,
      INDEX_HEAD_WIRE_BYTES);
    const ciphertextWire = boundedCopy(input.ciphertextWire, 65,
      MAX_INDEX_WIRE_BYTES);
    const expectedView = snapshotIdentity(input.expectedView);
    const expectedObjectId = input.expectedObjectId;
    if (typeof expectedObjectId !== "string" ||
      !OPAQUE_ID.test(expectedObjectId)) throw new EncryptedIndexIntegrityError();
    const verified = await verifyIndexHeadCandidate({ wire: headWire,
      ciphertextWire, expectedView, trustedSigner: input.trustedSigner,
      trustedGrantHeadSha256: input.trustedGrantHeadSha256,
      checkpoint: input.checkpoint });
    const context = decodeSignedIndexHead(headWire).context;
    if (context.objectId !== expectedObjectId ||
      context.sequence > 0xffffffffn)
      throw new EncryptedIndexIntegrityError();
    const blob = decodeManagedVaultBlobV2(ciphertextWire);
    if (blob.plaintextSize > MAX_INDEX_PLAINTEXT_BYTES)
      throw new EncryptedIndexIntegrityError();
    plaintext = await decryptManagedVaultBlobV2(input.indexKey, blob, {
      householdId: context.householdId,
      careProfileId: context.careProfileId,
      opaqueScopeId: context.viewId,
      objectId: context.objectId,
      keyEpoch: context.keyEpoch,
      purpose: "encrypted-index", revision: Number(context.sequence),
    });
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    const payload: unknown = JSON.parse(text);
    // Canonical JSON rejects duplicate keys, noncanonical escapes and surplus
    // whitespace before any parsed field is trusted.
    if (JSON.stringify(payload) !== text || !plainRecord(payload) ||
      !exactKeys(payload, ["format", "householdId", "careProfileId",
        "viewId", "indexKeyId", "keyEpoch", "objectId", "sequence",
        "entries"]) ||
      payload.format !== INDEX_FORMAT ||
      payload.householdId !== context.householdId ||
      payload.careProfileId !== context.careProfileId ||
      payload.viewId !== context.viewId ||
      payload.indexKeyId !== context.indexKeyId ||
      payload.keyEpoch !== context.keyEpoch ||
      payload.objectId !== context.objectId ||
      payload.sequence !== context.sequence.toString())
      throw new EncryptedIndexIntegrityError();
    const entries = validateEntries(payload.entries, context.careProfileId);
    const timeline = projectDecryptedTimeline(entries, context.careProfileId);
    const candidate = Object.freeze({ ...verified.candidate });
    const headSha256 = candidate.headSha256;
    return { state: verified.state, candidate, timeline,
      historyThroughDay: async (throughDay, options = {}) => {
        if (options.cursor !== undefined &&
          (!plainRecord(options.cursor) ||
            options.cursor.headSha256 !== headSha256 ||
            !plainRecord(options.cursor.history)))
          throw new DecryptedTimelineChanged();
        const page = await decryptedHistoryThroughDay(entries,
          context.careProfileId, throughDay, {
            ...(options.cursor ? { cursor: options.cursor.history } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          });
        return { ...page, headSha256,
          nextCursor: page.nextCursor ? {
            headSha256, history: page.nextCursor,
          } : null };
      } };
  } catch { throw new EncryptedIndexIntegrityError(); }
  finally { plaintext?.fill(0); }
}

function validateEntries(value: unknown, careProfileId: string): DecryptedTimelineEntry[] {
  if (!Array.isArray(value) || value.length > MAX_INDEX_ENTRIES)
    throw new EncryptedIndexIntegrityError();
  const copied: DecryptedTimelineEntry[] = [];
  let serializedBytes = 0;
  for (const candidate of value as unknown[]) {
    if (!plainRecord(candidate) || candidate.reviewState !== "approved" ||
      typeof candidate.id !== "string" || candidate.id.length !== 32 ||
      typeof candidate.careProfileId !== "string" ||
      candidate.careProfileId.length !== 32 ||
      typeof candidate.receivedAt !== "string" ||
      candidate.receivedAt.length !== 24 ||
      !Array.isArray(candidate.careDays) ||
      candidate.careDays.length > 366 ||
      candidate.careDays.some((day: unknown) =>
        typeof day !== "string" || day.length !== 10))
      throw new EncryptedIndexIntegrityError();
    let entry: DecryptedTimelineEntry;
    if (candidate.kind === "file") {
      if (!exactKeys(candidate, ["id", "careProfileId", "receivedAt",
        "careDays", "reviewState", "kind", "displayName", "printedDate",
        "pageNumbers"]) || !validPrintedDate(candidate.printedDate) ||
        typeof candidate.displayName !== "string" ||
        candidate.displayName.length > 256 ||
        !Array.isArray(candidate.pageNumbers) ||
        candidate.pageNumbers.length > 1000 ||
        candidate.pageNumbers.some((page: unknown) =>
          typeof page !== "number" || !Number.isSafeInteger(page) ||
          page < 1 || page > 10_000))
        throw new EncryptedIndexIntegrityError();
      entry = { id: candidate.id,
        careProfileId: candidate.careProfileId as string,
        receivedAt: candidate.receivedAt as string,
        careDays: [...candidate.careDays], reviewState: "approved",
        kind: "file", displayName: candidate.displayName as string,
        printedDate: candidate.printedDate === null ? null :
          (candidate.printedDate as { kind: string }).kind === "day" ?
            { kind: "day", value: (candidate.printedDate as
              { value: string }).value } :
            { kind: "unclear", originalText: (candidate.printedDate as
              { originalText: string }).originalText },
        pageNumbers: [...candidate.pageNumbers] };
    } else if (candidate.kind === "family_note") {
      if (!exactKeys(candidate, ["id", "careProfileId", "receivedAt",
        "careDays", "reviewState", "kind", "body", "authorLabel",
        "printedDate"]) || candidate.printedDate !== null ||
        typeof candidate.body !== "string" || candidate.body.length > 20_000 ||
        typeof candidate.authorLabel !== "string" ||
        candidate.authorLabel.length > 256)
        throw new EncryptedIndexIntegrityError();
      entry = { id: candidate.id,
        careProfileId: candidate.careProfileId as string,
        receivedAt: candidate.receivedAt as string,
        careDays: [...candidate.careDays], reviewState: "approved",
        kind: "family_note", body: candidate.body as string,
        authorLabel: candidate.authorLabel as string, printedDate: null };
    } else throw new EncryptedIndexIntegrityError();
    serializedBytes += new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (serializedBytes > MAX_INDEX_PLAINTEXT_BYTES - 1024)
      throw new EncryptedIndexIntegrityError();
    copied.push(entry);
  }
  // The existing projector enforces valid dates, page bounds, duplicate IDs,
  // a single profile, and sane text, but would silently omit pending entries.
  projectDecryptedTimeline(copied, careProfileId);
  return copied;
}

function validPrintedDate(value: unknown): boolean {
  if (value === null) return true;
  if (!plainRecord(value)) return false;
  return (value.kind === "day" &&
    exactKeys(value, ["kind", "value"]) &&
    typeof value.value === "string" && value.value.length === 10) ||
    (value.kind === "unclear" &&
      exactKeys(value, ["kind", "originalText"]) &&
      typeof value.originalText === "string" &&
      value.originalText.length <= 256);
}

function snapshotIdentity(value: IndexViewIdentity): IndexViewIdentity {
  if (!value || ![value.householdId, value.careProfileId, value.viewId,
    value.indexKeyId].every((id) => typeof id === "string" &&
      OPAQUE_ID.test(id)) || !Number.isSafeInteger(value.keyEpoch) ||
    value.keyEpoch < 1 || value.keyEpoch > 0xffffffff)
    throw new EncryptedIndexIntegrityError();
  return { householdId: value.householdId, careProfileId: value.careProfileId,
    viewId: value.viewId, indexKeyId: value.indexKeyId,
    keyEpoch: value.keyEpoch };
}

function boundedCopy(value: Uint8Array, minimum: number, maximum: number): Uint8Array {
  if (!ArrayBuffer.isView(value) ||
    Object.prototype.toString.call(value) !== "[object Uint8Array]" ||
    value.byteLength < minimum || value.byteLength > maximum)
    throw new EncryptedIndexIntegrityError();
  return Uint8Array.from(value);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index]);
}
