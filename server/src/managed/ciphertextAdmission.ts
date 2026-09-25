import express, { type Request } from "express";

import { MAX_MANAGED_VAULT_WIRE_BYTES, MANAGED_VAULT_CHUNK_BYTES } from
  "@adeno/contracts";
import { preflightCookieMutation, verifyStoredMutationSession,
  type SessionRepository, type VerifiedSession } from "../auth/cookieSession.js";
import { stageManagedVaultWireV2Stream, VaultWireStreamError,
  type VaultWireChunk, type VaultWireHeader, type VaultWireStagingSink } from
  "./vaultWireStream.js";

const MEDIA_TYPE = "application/vnd.adeno.vault.v2";
const ROUTE = "/api/v3/vault/intents/:intentId/blobs/:blobId";
const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const DEFAULT_INGRESS_DEADLINE_MS = 30_000;

export class ManagedVaultUploadDeniedError extends Error {}
export class ManagedVaultUploadExistsError extends Error {}
export class ManagedVaultUploadSessionError extends Error {}

export type ManagedVaultUploadHeader = VaultWireHeader & { wireVersion: 2 };

export interface ManagedVaultUploadSink {
  begin(header: ManagedVaultUploadHeader): Promise<void> | void;
  append(chunk: VaultWireChunk): Promise<void> | void;
  commit(header: ManagedVaultUploadHeader, wireSha256: string,
    signal: AbortSignal): Promise<void> | void;
  abort(): Promise<void> | void;
}

/**
 * open must load an intent created earlier and bind it to a server-reserved blob
 * ID, opaque profile/scope/purpose, current member/device/grant and revision.
 * It must not derive the expected blob ID from the caller's URL. The returned
 * sink may stage privately, but commit MUST atomically recheck the current
 * session, intent, grant, expected revision, nonce reservations and signal
 * before publishing. The supplied wireSha256 is the hash of the exact parsed
 * request bytes; the store must compare it with its re-read object proof.
 * Open and commit need their own bounded, cooperative
 * storage deadlines; the route timer below bounds ingress only. Abort must
 * discard all uncommitted staged material.
 * Nothing here proves that a client actually encrypted its bytes.
 */
export interface ManagedVaultUploadStore {
  open(input: {
    session: VerifiedSession;
    preflight: { tokenSha256: string; csrfToken: string };
    intentId: string;
    signal: AbortSignal;
  }): Promise<{ expectedBlobId: string; sink: ManagedVaultUploadSink } | null>;
}

/** Unmounted route factory. Do not expose without a reviewed durable grant store. */
export function createManagedCiphertextAdmissionRouter(input: {
  sessions: SessionRepository;
  expectedOrigin: string;
  store: ManagedVaultUploadStore;
  ingressDeadlineMs?: number;
}) {
  const ingressDeadlineMs = input.ingressDeadlineMs ?? DEFAULT_INGRESS_DEADLINE_MS;
  if (!/^https?:\/\/[^/]+$/.test(input.expectedOrigin) ||
    !Number.isSafeInteger(ingressDeadlineMs) || ingressDeadlineMs < 1 ||
    ingressDeadlineMs > 120_000)
    throw new Error("Invalid ciphertext admission configuration");
  const router = express.Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  router.post(ROUTE, async (request, response) => {
    const preflight = preflightCookieMutation(request, input.expectedOrigin);
    if (!preflight.ok) {
      response.status(preflight.status).json({ error: preflight.error });
      return;
    }
    const intentId = request.params.intentId;
    const blobId = request.params.blobId;
    if (typeof intentId !== "string" || !OPAQUE_ID.test(intentId) ||
      typeof blobId !== "string" || !OPAQUE_ID.test(blobId)) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    if (request.get("content-type") !== MEDIA_TYPE) {
      response.status(415).json({ error: "INVALID_WIRE" });
      return;
    }
    const lengths = request.rawHeaders.filter((_value, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === "content-length");
    const declared = request.get("content-length");
    if (lengths.length > 1 || (declared !== undefined &&
      (!/^(0|[1-9][0-9]*)$/u.test(declared) ||
        Number(declared) > MAX_MANAGED_VAULT_WIRE_BYTES)) ||
      (declared !== undefined && request.get("transfer-encoding") !== undefined)) {
      response.status(413).json({ error: "INVALID_WIRE" });
      return;
    }

    let sink: ManagedVaultUploadSink | null = null;
    let sinkAborted = false;
    const controller = new AbortController();
    let ingressTimer: ReturnType<typeof setTimeout> | null = null;
    const onClose = () => { if (!request.complete) controller.abort(); };
    request.once("aborted", onClose);
    request.once("close", onClose);
    try {
      const row = await input.sessions.findByTokenSha256(preflight.tokenSha256);
      if (controller.signal.aborted) throw new VaultWireStreamError();
      const decision = verifyStoredMutationSession(row, preflight.csrfToken);
      if (!decision.ok) {
        response.status(decision.status).json({ error: decision.error });
        return;
      }
      const opened = await input.store.open({ session: decision.session, preflight,
        intentId, signal: controller.signal });
      sink = opened?.sink ?? null;
      if (controller.signal.aborted) throw new VaultWireStreamError();
      if (!opened) {
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      if (!OPAQUE_ID.test(opened.expectedBlobId) ||
        opened.expectedBlobId !== blobId) {
        sinkAborted = true;
        await opened.sink.abort();
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      const currentSink = opened.sink;
      ingressTimer = setTimeout(() => {
        controller.abort();
        request.destroy();
      }, ingressDeadlineMs);
      const checkedSink: VaultWireStagingSink = {
        begin: (header) => {
          if (!isV2Header(header) || header.blobId !== blobId)
            throw new VaultWireStreamError();
          return currentSink.begin(header);
        },
        append: (chunk) => currentSink.append(chunk),
        commit: (header, wireSha256) => {
          if (!isV2Header(header) || header.blobId !== blobId)
            throw new VaultWireStreamError();
          if (ingressTimer !== null) clearTimeout(ingressTimer);
          ingressTimer = null;
          if (controller.signal.aborted) throw new VaultWireStreamError();
          return currentSink.commit(header, wireSha256, controller.signal);
        },
        abort: () => {
          sinkAborted = true;
          return currentSink.abort();
        },
      };
      await stageManagedVaultWireV2Stream(boundedFragments(request),
        checkedSink, controller.signal);
      if (!response.destroyed) response.status(201).json({ status: "stored" });
    } catch (error) {
      if (sink && !sinkAborted) {
        try { await sink.abort(); } catch { /* Never expose storage details. */ }
      }
      if (response.destroyed) return;
      if (error instanceof ManagedVaultUploadExistsError) {
        response.status(409).json({ error: "ALREADY_EXISTS" });
      } else if (error instanceof ManagedVaultUploadSessionError) {
        response.status(401).json({ error: "AUTH_REQUIRED" });
      } else if (error instanceof ManagedVaultUploadDeniedError) {
        response.status(404).json({ error: "NOT_FOUND" });
      } else if (error instanceof VaultWireStreamError) {
        response.status(422).json({ error: "INVALID_WIRE" });
      } else {
        response.status(500).json({ error: "UNAVAILABLE" });
      }
    } finally {
      if (ingressTimer !== null) clearTimeout(ingressTimer);
      request.off("aborted", onClose);
      request.off("close", onClose);
    }
  });
  return router;
}

function isV2Header(header: VaultWireHeader): header is ManagedVaultUploadHeader {
  return header.wireVersion === 2;
}

async function* boundedFragments(request: Request): AsyncGenerator<Uint8Array> {
  for await (const value of request) {
    if (!(value instanceof Uint8Array)) throw new VaultWireStreamError();
    for (let offset = 0; offset < value.byteLength; offset += MANAGED_VAULT_CHUNK_BYTES)
      yield value.subarray(offset, Math.min(value.byteLength,
        offset + MANAGED_VAULT_CHUNK_BYTES));
  }
}
