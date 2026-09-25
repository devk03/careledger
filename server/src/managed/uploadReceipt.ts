import express from "express";

import { MAX_MANAGED_VAULT_WIRE_BYTES } from "@adeno/contracts";
import { preflightCookieMutation } from "../auth/cookieSession.js";
import { ManagedVaultUploadDeniedError, ManagedVaultUploadSessionError } from
  "./ciphertextAdmission.js";

const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const ROUTE = "/api/v3/vault/intents/:intentId/blobs/:blobId/receipt";

export type ManagedUploadReceipt =
  | { status: "committed"; wireSha256: string; wireBytes: number }
  | { status: "unconfirmed" };

export interface ManagedUploadReceiptReader {
  /** Recheck a current session, original writer account/device and current grant. */
  readReceipt(input: { tokenSha256: string; csrfToken: string;
    intentId: string; blobId: string }): Promise<ManagedUploadReceipt | null>;
}

export class ManagedUploadReceiptCsrfError extends Error {}

/**
 * Unmounted, bodyless same-origin receipt lookup. A committed response only
 * proves ciphertext bytes were stored; it does not publish a care-day revision.
 * An unconfirmed response is never permission to replay a nonce or intent.
 */
export function createManagedUploadReceiptRouter(input: {
  expectedOrigin: string;
  reader: ManagedUploadReceiptReader;
}) {
  if (!/^https?:\/\/[^/]+$/u.test(input.expectedOrigin))
    throw new Error("Invalid managed receipt origin");
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
    const { intentId, blobId } = request.params;
    if (typeof intentId !== "string" || !OPAQUE_ID.test(intentId) ||
      typeof blobId !== "string" || !OPAQUE_ID.test(blobId)) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    const lengths = request.rawHeaders.filter((_value, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === "content-length");
    if (lengths.length > 1 || request.get("transfer-encoding") !== undefined ||
      (request.get("content-length") !== undefined &&
        request.get("content-length") !== "0")) {
      response.status(400).json({ error: "BODY_NOT_ALLOWED" });
      return;
    }
    try {
      const receipt = await input.reader.readReceipt({
        tokenSha256: preflight.tokenSha256, csrfToken: preflight.csrfToken,
        intentId, blobId,
      });
      if (!receipt) {
        response.status(404).json({ error: "NOT_FOUND" });
      } else if (receipt.status === "unconfirmed") {
        response.status(202).json({ status: "unconfirmed" });
      } else if (receipt.status === "committed" &&
        /^[0-9a-f]{64}$/u.test(receipt.wireSha256) &&
        Number.isSafeInteger(receipt.wireBytes) && receipt.wireBytes >= 65 &&
        receipt.wireBytes <= MAX_MANAGED_VAULT_WIRE_BYTES) {
        response.status(200).json({ status: "committed",
          wireSha256: receipt.wireSha256, wireBytes: receipt.wireBytes });
      } else {
        response.status(500).json({ error: "UNAVAILABLE" });
      }
    } catch (error) {
      if (error instanceof ManagedVaultUploadSessionError)
        response.status(401).json({ error: "AUTH_REQUIRED" });
      else if (error instanceof ManagedUploadReceiptCsrfError)
        response.status(403).json({ error: "INVALID_CSRF" });
      else if (error instanceof ManagedVaultUploadDeniedError)
        response.status(404).json({ error: "NOT_FOUND" });
      else response.status(500).json({ error: "UNAVAILABLE" });
    }
  });
  return router;
}
