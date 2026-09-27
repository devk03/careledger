import { decodeManagedVaultBlobV2 } from "@adeno/contracts";

import { checkCiphertextUploadReceipt } from "./uploadReceipt";

const ID = /^[0-9a-f]{32}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CSRF = /^v1\.[A-Za-z0-9_-]{32}\.[0-9a-f]{64}$/u;
const PREFIX = "adeno:managed:draft-upload:v1:";
const MAX_CONTENT_WIRE = 33 + 16 * 1024 * 1024 + 32 * 16;
const MAX_METADATA_WIRE = 32 * 1024;
const RECORD_KEYS = ["version", "householdId", "accountId", "sessionId",
  "reservationId", "contentIntentId", "metadataIntentId",
  "contentBlobId", "metadataBlobId", "contentWireSha256",
  "metadataWireSha256", "contentWireBytes", "metadataWireBytes",
  "contentState", "metadataState"];
const SORTED_RECORD_KEYS = [...RECORD_KEYS].sort();

export type DraftUploadTuple = { householdId: string; accountId: string;
  sessionId: string; reservationId: string };
export type DraftUploadJournalRecord = DraftUploadTuple & {
  version: 1;
  contentIntentId: string; metadataIntentId: string;
  contentBlobId: string; metadataBlobId: string;
  contentWireSha256: string; metadataWireSha256: string;
  contentWireBytes: number; metadataWireBytes: number;
  contentState: "prepared" | "attempted";
  metadataState: "prepared" | "attempted";
};

export class DraftUploadJournalUnavailable extends Error {
  constructor() { super("The encrypted upload journal is unavailable."); }
}
export class DraftUploadJournalConflict extends Error {
  constructor() { super("The encrypted upload journal does not match."); }
}

/**
 * Browser-local, opaque-only journal. Save and read back both exact wire
 * digests before ANY upload. A role is permanently marked attempted before
 * its first POST; after any crash, network error or response, use receipts
 * only and never re-send the one-use intent. It does not retain ciphertext,
 * keys, filenames, care dates or plaintext, and is not power-loss durability.
 */
export async function savePreparedDraftUpload(input: DraftUploadTuple & {
  contentIntentId: string; metadataIntentId: string;
  contentBlobId: string; metadataBlobId: string;
  contentWire: Uint8Array; metadataWire: Uint8Array;
}): Promise<DraftUploadJournalRecord> {
  const tuple = validateTuple(input);
  const content = copyWire(input.contentWire, MAX_CONTENT_WIRE,
    input.contentBlobId);
  const metadata = copyWire(input.metadataWire, MAX_METADATA_WIRE,
    input.metadataBlobId);
  if (!ID.test(input.contentIntentId) ||
    !ID.test(input.metadataIntentId) ||
    !ID.test(input.contentBlobId) || !ID.test(input.metadataBlobId) ||
    input.contentIntentId === input.metadataIntentId ||
    input.contentBlobId === input.metadataBlobId)
    throw new DraftUploadJournalConflict();
  const proposed: DraftUploadJournalRecord = { version: 1, ...tuple,
    contentIntentId: input.contentIntentId,
    metadataIntentId: input.metadataIntentId,
    contentBlobId: input.contentBlobId,
    metadataBlobId: input.metadataBlobId,
    contentWireSha256: await sha256(content),
    metadataWireSha256: await sha256(metadata),
    contentWireBytes: content.byteLength,
    metadataWireBytes: metadata.byteLength,
    contentState: "prepared", metadataState: "prepared" };
  return locked(tuple, () => {
    const existing = loadPreparedDraftUpload(tuple);
    if (existing) {
      if (!sameImmutable(existing, proposed))
        throw new DraftUploadJournalConflict();
      return existing;
    }
    writeAndReadBack(proposed);
    return proposed;
  });
}

/** Exact-tuple lookup only; no list-all or automatic deletion. */
export function loadPreparedDraftUpload(tupleInput: DraftUploadTuple):
  DraftUploadJournalRecord | null {
  const tuple = validateTuple(tupleInput);
  let raw: string | null;
  try { raw = localStorage.getItem(storageKey(tuple)); }
  catch { throw new DraftUploadJournalUnavailable(); }
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new DraftUploadJournalConflict(); }
  if (!validRecord(value, tuple)) throw new DraftUploadJournalConflict();
  return value;
}

/**
 * A second tab waits for the first tab's Web Lock, then sees attempted and
 * cannot POST again. If Web Locks or local storage are unavailable, fail closed.
 * Even HTTP 201/409 is followed by an exact receipt check, not a retry.
 */
export async function attemptDraftUploadRole(input: {
  tuple: DraftUploadTuple; role: "content" | "metadata";
  wire: Uint8Array; csrfToken: string; fetcher?: typeof fetch;
}): Promise<"committed" | "unconfirmed"> {
  const tuple = validateTuple(input.tuple);
  const role = input.role;
  if (role !== "content" && role !== "metadata")
    throw new DraftUploadJournalConflict();
  if (typeof input.csrfToken !== "string" || !CSRF.test(input.csrfToken))
    throw new DraftUploadJournalConflict();
  const wire = copyWire(input.wire,
    role === "content" ? MAX_CONTENT_WIRE : MAX_METADATA_WIRE);
  const digest = await sha256(wire);
  const saved = loadPreparedDraftUpload(tuple);
  if (!saved || digest !== saved[`${role}WireSha256`] ||
    wire.byteLength !== saved[`${role}WireBytes`])
    throw new DraftUploadJournalConflict();
  const shouldSend = await locked(tuple, () => {
    const current = loadPreparedDraftUpload(tuple);
    if (!current || !sameImmutable(current, saved))
      throw new DraftUploadJournalConflict();
    if (current[`${role}State`] === "attempted") return false;
    writeAndReadBack({ ...current, [`${role}State`]: "attempted" });
    return true;
  });
  const intentId = saved[`${role}IntentId`];
  const blobId = saved[`${role}BlobId`];
  const fetcher = input.fetcher ?? fetch;
  if (shouldSend) {
    try {
      await fetcher(`/api/v3/vault/intents/${intentId}/blobs/${blobId}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        redirect: "error", headers: {
          "content-type": "application/vnd.adeno.vault.v2",
          "x-csrf-token": input.csrfToken }, body: wire });
    } catch { /* Outcome is unknown; receipt-only reconciliation follows. */ }
  }
  return checkCiphertextUploadReceipt({ saved: { intentId, blobId,
    wireSha256: digest, wireBytes: wire.byteLength },
    csrfToken: input.csrfToken, fetcher });
}

/** Reload recovery never sends ciphertext, even when a receipt is absent. */
export async function reconcileDraftUpload(input: {
  tuple: DraftUploadTuple; csrfToken: string; fetcher?: typeof fetch;
}): Promise<{ content: "committed" | "unconfirmed";
  metadata: "committed" | "unconfirmed" }> {
  const saved = loadPreparedDraftUpload(input.tuple);
  if (!saved) throw new DraftUploadJournalConflict();
  const fetcher = input.fetcher ?? fetch;
  const receipt = (role: "content" | "metadata") =>
    checkCiphertextUploadReceipt({ saved: {
      intentId: saved[`${role}IntentId`],
      blobId: saved[`${role}BlobId`],
      wireSha256: saved[`${role}WireSha256`],
      wireBytes: saved[`${role}WireBytes`] },
    csrfToken: input.csrfToken, fetcher });
  return { content: await receipt("content"),
    metadata: await receipt("metadata") };
}

function validateTuple(input: DraftUploadTuple): DraftUploadTuple {
  if (!input || ![input.householdId, input.accountId,
    input.sessionId, input.reservationId]
    .every((value) => typeof value === "string" && ID.test(value)))
    throw new DraftUploadJournalConflict();
  return { householdId: input.householdId, accountId: input.accountId,
    sessionId: input.sessionId, reservationId: input.reservationId };
}

function storageKey(tuple: DraftUploadTuple): string {
  return PREFIX + [tuple.householdId, tuple.accountId, tuple.sessionId,
    tuple.reservationId].join(":");
}

async function locked<T>(tuple: DraftUploadTuple,
  action: () => T): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request)
    throw new DraftUploadJournalUnavailable();
  try { return await navigator.locks.request(storageKey(tuple),
    { mode: "exclusive" }, action); }
  catch (error) {
    if (error instanceof DraftUploadJournalConflict ||
      error instanceof DraftUploadJournalUnavailable) throw error;
    throw new DraftUploadJournalUnavailable();
  }
}

function writeAndReadBack(value: DraftUploadJournalRecord): void {
  const raw = JSON.stringify(value);
  try {
    const key = storageKey(value);
    localStorage.setItem(key, raw);
    if (localStorage.getItem(key) !== raw)
      throw new DraftUploadJournalUnavailable();
  } catch { throw new DraftUploadJournalUnavailable(); }
}

function validRecord(value: unknown, tuple: DraftUploadTuple):
  value is DraftUploadJournalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length ||
    keys.some((key, index) => key !== SORTED_RECORD_KEYS[index]))
    return false;
  return record.version === 1 &&
    record.householdId === tuple.householdId &&
    record.accountId === tuple.accountId &&
    record.sessionId === tuple.sessionId &&
    record.reservationId === tuple.reservationId &&
    [record.contentIntentId, record.metadataIntentId,
      record.contentBlobId, record.metadataBlobId]
      .every((id) => typeof id === "string" && ID.test(id)) &&
    record.contentIntentId !== record.metadataIntentId &&
    record.contentBlobId !== record.metadataBlobId &&
    [record.contentWireSha256, record.metadataWireSha256]
      .every((hash) => typeof hash === "string" && HASH.test(hash)) &&
    Number.isSafeInteger(record.contentWireBytes) &&
    (record.contentWireBytes as number) >= 65 &&
    (record.contentWireBytes as number) <= MAX_CONTENT_WIRE &&
    Number.isSafeInteger(record.metadataWireBytes) &&
    (record.metadataWireBytes as number) >= 65 &&
    (record.metadataWireBytes as number) <= MAX_METADATA_WIRE &&
    [record.contentState, record.metadataState]
      .every((state) => state === "prepared" || state === "attempted");
}

function sameImmutable(a: DraftUploadJournalRecord,
  b: DraftUploadJournalRecord): boolean {
  return RECORD_KEYS.filter((key) => key !== "contentState" &&
    key !== "metadataState")
    .every((key) => a[key as keyof DraftUploadJournalRecord] ===
      b[key as keyof DraftUploadJournalRecord]);
}

function copyWire(value: Uint8Array, maximum: number,
  expectedBlobId?: string): Uint8Array {
  if (!ArrayBuffer.isView(value) ||
    Object.prototype.toString.call(value) !== "[object Uint8Array]" ||
    value.byteLength < 65 || value.byteLength > maximum)
    throw new DraftUploadJournalConflict();
  const copy = Uint8Array.from(value);
  try {
    const decoded = decodeManagedVaultBlobV2(copy);
    if (expectedBlobId &&
      hex(decoded.blobId) !== expectedBlobId)
      throw new DraftUploadJournalConflict();
  } catch { throw new DraftUploadJournalConflict(); }
  return copy;
}

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(value: Uint8Array): Promise<string> {
  const exact = new Uint8Array(value.byteLength);
  exact.set(value);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",
    exact.buffer)));
}
