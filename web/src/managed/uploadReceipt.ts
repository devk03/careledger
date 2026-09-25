const OPAQUE_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export type SavedCiphertextUpload = {
  intentId: string;
  blobId: string;
  wireSha256: string;
  wireBytes: number;
};

export class UploadReceiptUnavailable extends Error {}
export class UploadReceiptMismatch extends Error {}

/**
 * Check a locally retained upload digest after an ambiguous POST result.
 * A missing receipt is not proof of failure, and this function never retries
 * the one-use intent or its AES-GCM nonce.
 */
export async function checkCiphertextUploadReceipt(input: {
  saved: SavedCiphertextUpload;
  csrfToken: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<"committed" | "unconfirmed"> {
  const { saved } = input;
  if (!OPAQUE_ID.test(saved.intentId) || !OPAQUE_ID.test(saved.blobId) ||
    !SHA256.test(saved.wireSha256) || !Number.isSafeInteger(saved.wireBytes) ||
    saved.wireBytes < 65 || !input.csrfToken)
    throw new UploadReceiptUnavailable("Invalid locally saved upload receipt context");
  const path = `/api/v3/vault/intents/${saved.intentId}/blobs/${saved.blobId}/receipt`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      response = await (input.fetcher ?? fetch)(path, { method: "POST",
        credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: controller.signal,
        headers: { "x-csrf-token": input.csrfToken } });
    } catch {
      throw new UploadReceiptUnavailable("Upload result is still unknown");
    }
    if (controller.signal.aborted || response.redirected)
      throw new UploadReceiptUnavailable("Upload result is still unknown");
    if (response.status === 202) {
      const body = await readReceiptBody(response);
      if (isObject(body) && body.status === "unconfirmed") return "unconfirmed";
      throw new UploadReceiptUnavailable("Invalid unconfirmed receipt");
    }
    if (response.status !== 200)
      throw new UploadReceiptUnavailable("Upload result is still unknown");
    const body = await readReceiptBody(response);
    if (!isObject(body) || body.status !== "committed" ||
      typeof body.wireSha256 !== "string" || !SHA256.test(body.wireSha256) ||
      typeof body.wireBytes !== "number" ||
      !Number.isSafeInteger(body.wireBytes))
      throw new UploadReceiptUnavailable("Invalid committed receipt");
    if (body.wireSha256 !== saved.wireSha256 || body.wireBytes !== saved.wireBytes)
      throw new UploadReceiptMismatch("Committed ciphertext differs from the saved upload");
    return "committed";
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readReceiptBody(response: Response): Promise<unknown> {
  try { return await response.json(); } catch {
    throw new UploadReceiptUnavailable("Invalid upload receipt response");
  }
}
