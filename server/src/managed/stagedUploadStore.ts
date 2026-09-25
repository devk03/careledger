import { MANAGED_VAULT_CHUNK_BYTES, MAX_MANAGED_VAULT_BYTES } from
  "@adeno/contracts";

import type { VerifiedSession } from "../auth/cookieSession.js";
import { ManagedVaultUploadDeniedError,
  type ManagedVaultUploadHeader, type ManagedVaultUploadStore } from
  "./ciphertextAdmission.js";
import { proveStoredCiphertextWire, type StagedCiphertextChunk } from
  "./ciphertextCommitProof.js";
import { storeCiphertextChunk } from "./ciphertextObjectStore.js";
import { VaultWireStreamError } from "./vaultWireStream.js";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const OPEN_DEADLINE_MS = 5_000;
const STAGING_DEADLINE_MS = 120_000;

export type ManagedStagingIntent = {
  householdId: string;
  accountId: string;
  sessionId: string;
  intentId: string;
  attemptId: string;
  blobId: string;
  plaintextBytes: number;
  chunkCount: number;
};

export type VerifiedUploadChunkRow = {
  index: number;
  iv: Buffer;
  storageObjectId: string;
  ciphertextSha256: Buffer;
  ciphertextBytes: number;
};

export interface ManagedUploadLedger {
  /** Recheck current authority; reserve one full wire before any object write. */
  openForStaging(input: {
    session: VerifiedSession;
    tokenSha256: string;
    csrfToken: string;
    intentId: string;
    signal: AbortSignal;
  }): Promise<ManagedStagingIntent | null>;

  /**
   * One database transaction: reload the session and intent, verify CSRF and
   * auth versions, active device/member/grant, nonce uniqueness, quota and
   * one-use state, then insert immutable chunks and committed blob. Check the
   * signal before commit. Never trust the earlier openForStaging decision.
   */
  publishVerified(input: {
    intent: ManagedStagingIntent;
    tokenSha256: string;
    csrfToken: string;
    wireSha256: Buffer;
    wireBytes: number;
    chunks: readonly VerifiedUploadChunkRow[];
    signal: AbortSignal;
  }): Promise<void>;
}

/**
 * Unmounted disk-staging adapter. It joins the HTTP parser's exact-byte hash
 * to the re-read object proof and passes only verified metadata to a future
 * atomic ledger. This is not safe to mount without a real ledger, orphan
 * reconciliation, storage quotas, and managed auth.
 */
export function createStagedManagedVaultUploadStore(input: {
  objectRoot: string;
  ledger: ManagedUploadLedger;
  openDeadlineMs?: number;
  stagingDeadlineMs?: number;
}): ManagedVaultUploadStore {
  const openDeadlineMs = input.openDeadlineMs ?? OPEN_DEADLINE_MS;
  const stagingDeadlineMs = input.stagingDeadlineMs ?? STAGING_DEADLINE_MS;
  if (!Number.isSafeInteger(openDeadlineMs) || openDeadlineMs < 1 ||
    openDeadlineMs > OPEN_DEADLINE_MS || !Number.isSafeInteger(stagingDeadlineMs) ||
    stagingDeadlineMs < 1 || stagingDeadlineMs > STAGING_DEADLINE_MS)
    throw new Error("Invalid managed staging deadlines");
  return { open: async ({ session, preflight, intentId, signal }) => {
    if (signal.aborted || !OPAQUE_ID.test(intentId)) return null;
    const openSignal = AbortSignal.any([signal, AbortSignal.timeout(openDeadlineMs)]);
    const loaded = await bounded(input.ledger.openForStaging({ session,
      tokenSha256: preflight.tokenSha256, csrfToken: preflight.csrfToken,
      intentId, signal: openSignal }), openSignal);
    if (!loaded || openSignal.aborted) return null;
    if (!OPAQUE_ID.test(loaded.householdId) || !OPAQUE_ID.test(loaded.intentId) ||
      !OPAQUE_ID.test(loaded.attemptId) ||
      !OPAQUE_ID.test(loaded.blobId) || loaded.intentId !== intentId ||
      loaded.householdId !== session.scope.householdId ||
      loaded.accountId !== session.scope.userId ||
      loaded.sessionId !== session.sessionId ||
      !Number.isSafeInteger(loaded.plaintextBytes) || loaded.plaintextBytes < 0 ||
      loaded.plaintextBytes > MAX_MANAGED_VAULT_BYTES ||
      !Number.isSafeInteger(loaded.chunkCount) ||
      loaded.chunkCount !== Math.max(1,
        Math.ceil(loaded.plaintextBytes / MANAGED_VAULT_CHUNK_BYTES)))
      throw new ManagedVaultUploadDeniedError();
    const intent = Object.freeze({ ...loaded });

    const cancelled = new AbortController();
    const stagingSignal = AbortSignal.any([signal, cancelled.signal,
      AbortSignal.timeout(stagingDeadlineMs)]);
    let header: ManagedVaultUploadHeader | null = null;
    let phase: "ready" | "committing" | "published" | "aborted" = "ready";
    const chunks: StagedCiphertextChunk[] = [];
    return { expectedBlobId: intent.blobId, sink: {
      begin(value) {
        if (phase !== "ready" || header !== null || stagingSignal.aborted ||
          value.blobId !== intent.blobId ||
          value.plaintextSize !== intent.plaintextBytes ||
          value.chunkCount !== intent.chunkCount)
          throw new VaultWireStreamError();
        header = value;
      },
      async append(chunk) {
        if (phase !== "ready" || header === null || stagingSignal.aborted ||
          chunk.index !== chunks.length || chunks.length >= intent.chunkCount)
          throw new VaultWireStreamError();
        const stored = await bounded(storeCiphertextChunk(input.objectRoot,
          intent.householdId, chunk.ciphertext), stagingSignal);
        if (stagingSignal.aborted || phase !== "ready") throw new VaultWireStreamError();
        chunks.push({ index: chunk.index, iv: Buffer.from(chunk.iv),
          storageObjectId: stored.storageObjectId, sha256: stored.sha256,
          byteSize: stored.byteSize });
      },
      async commit(value, wireSha256, commitSignal) {
        if (phase !== "ready" || header === null || stagingSignal.aborted ||
          commitSignal.aborted ||
          value !== header || chunks.length !== intent.chunkCount)
          throw new VaultWireStreamError();
        phase = "committing";
        const publicationSignal = AbortSignal.any([stagingSignal, commitSignal]);
        try {
          const proof = await bounded(proveStoredCiphertextWire({
            root: input.objectRoot, householdId: intent.householdId,
            blobId: intent.blobId, plaintextBytes: intent.plaintextBytes,
            expectedWireSha256: wireSha256,
            expectedWireBytes: value.expectedWireBytes, chunks,
            signal: publicationSignal,
          }), publicationSignal);
          if (publicationSignal.aborted || phase !== "committing")
            throw new VaultWireStreamError();
          const verified = chunks.map((chunk): VerifiedUploadChunkRow => ({
            index: chunk.index, iv: Buffer.from(chunk.iv),
            storageObjectId: chunk.storageObjectId,
            ciphertextSha256: Buffer.from(chunk.sha256, "hex"),
            ciphertextBytes: chunk.byteSize,
          }));
          await bounded(input.ledger.publishVerified({ intent,
            tokenSha256: preflight.tokenSha256, csrfToken: preflight.csrfToken,
            wireSha256: Buffer.from(proof.wireSha256, "hex"),
            wireBytes: proof.wireBytes, chunks: verified,
            signal: publicationSignal,
          }), publicationSignal);
          if (publicationSignal.aborted || phase !== "committing")
            throw new VaultWireStreamError();
          phase = "published";
        } finally {
          if (phase !== "published") phase = "aborted";
          chunks.length = 0;
        }
      },
      abort() {
        if (phase === "published") return;
        const wasCommitting = phase === "committing";
        phase = "aborted";
        cancelled.abort();
        if (!wasCommitting) chunks.length = 0;
        // Create-only objects remain unreferenced until a reviewed reconciler
        // quarantines them. No API/backup may enumerate uncommitted objects.
      },
    } };
  } };
}

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Managed staging unavailable"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Managed staging unavailable"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}
