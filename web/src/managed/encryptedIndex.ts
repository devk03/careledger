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
    if (!plainRecord(candidate))
      throw new EncryptedIndexIntegrityError();
    const { id, careProfileId: profileId, receivedAt, careDays,
      reviewState, kind } = candidate;
    if (!Array.isArray(careDays)) throw new EncryptedIndexIntegrityError();
    const dayCount = careDays.length;
    if (reviewState !== "approved" ||
      typeof id !== "string" || id.length !== 32 ||
      typeof profileId !== "string" || profileId.length !== 32 ||
      typeof receivedAt !== "string" || receivedAt.length !== 24 ||
      dayCount > 366)
      throw new EncryptedIndexIntegrityError();
    const copiedDays: string[] = [];
    for (let index = 0; index < dayCount; index++) {
      const day: unknown = careDays[index];
      if (typeof day !== "string" || day.length !== 10)
        throw new EncryptedIndexIntegrityError();
      copiedDays.push(day);
    }
    const common = { id, careProfileId: profileId, receivedAt,
      careDays: copiedDays, reviewState: "approved" as const };
    let entry: DecryptedTimelineEntry;
    if (kind === "file") {
      if (!exactKeys(candidate, ["id", "careProfileId", "receivedAt",
        "careDays", "reviewState", "kind", "displayName", "printedDate",
        "pageNumbers"]))
        throw new EncryptedIndexIntegrityError();
      const displayName = candidate.displayName;
      const pageNumbers = candidate.pageNumbers;
      const printedDate = copyPrintedDate(candidate.printedDate);
      if (!Array.isArray(pageNumbers))
        throw new EncryptedIndexIntegrityError();
      const pageCount = pageNumbers.length;
      if (typeof displayName !== "string" || displayName.length > 256 ||
        pageCount > 1000)
        throw new EncryptedIndexIntegrityError();
      const copiedPages: number[] = [];
      for (let index = 0; index < pageCount; index++) {
        const page: unknown = pageNumbers[index];
        if (typeof page !== "number" || !Number.isSafeInteger(page) ||
          page < 1 || page > 10_000)
          throw new EncryptedIndexIntegrityError();
        copiedPages.push(page);
      }
      entry = { ...common, kind: "file", displayName, printedDate,
        pageNumbers: copiedPages };
    } else if (kind === "family_note") {
      if (!exactKeys(candidate, ["id", "careProfileId", "receivedAt",
        "careDays", "reviewState", "kind", "body", "authorLabel",
        "printedDate"]))
        throw new EncryptedIndexIntegrityError();
      const body = candidate.body;
      const authorLabel = candidate.authorLabel;
      const printedDate = candidate.printedDate;
      if (printedDate !== null || typeof body !== "string" ||
        body.length > 20_000 || typeof authorLabel !== "string" ||
        authorLabel.length > 256)
        throw new EncryptedIndexIntegrityError();
      entry = { ...common, kind: "family_note", body, authorLabel,
        printedDate: null };
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

function copyPrintedDate(value: unknown): Extract<DecryptedTimelineEntry,
  { kind: "file" }>["printedDate"] {
  if (value === null) return null;
  if (!plainRecord(value)) throw new EncryptedIndexIntegrityError();
  const kind = value.kind;
  if (kind === "day" && exactKeys(value, ["kind", "value"])) {
    const day = value.value;
    if (typeof day === "string" && day.length === 10)
      return { kind: "day", value: day };
  } else if (kind === "unclear" &&
    exactKeys(value, ["kind", "originalText"])) {
    const originalText = value.originalText;
    if (typeof originalText === "string" && originalText.length <= 256)
      return { kind: "unclear", originalText };
  }
  throw new EncryptedIndexIntegrityError();
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
