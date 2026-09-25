import { describe, expect, it, vi } from "vitest";

import { checkCiphertextUploadReceipt, UploadReceiptMismatch,
  UploadReceiptUnavailable } from "./uploadReceipt";

const saved = { intentId: "aa".repeat(16), blobId: "bb".repeat(16),
  wireSha256: "cc".repeat(32), wireBytes: 84 };

function reply(status: number, value: unknown) {
  return vi.fn(async () => ({ status, json: async () => value } as Response));
}

describe("managed ciphertext upload receipt check", () => {
  it("confirms only an exact match to the locally retained wire digest and length", async () => {
    const fetcher = reply(200, { status: "committed", wireSha256: saved.wireSha256,
      wireBytes: saved.wireBytes });
    await expect(checkCiphertextUploadReceipt({ saved, csrfToken: "fictional-csrf",
      fetcher })).resolves.toBe("committed");
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v3/vault/intents/${saved.intentId}/blobs/${saved.blobId}/receipt`,
      expect.objectContaining({ method: "POST", credentials: "same-origin",
        cache: "no-store", redirect: "error", signal: expect.any(AbortSignal),
        headers: { "x-csrf-token": "fictional-csrf" } }));
  });

  it("rejects a committed response for different bytes", async () => {
    for (const body of [
      { status: "committed", wireSha256: "dd".repeat(32), wireBytes: 84 },
      { status: "committed", wireSha256: saved.wireSha256, wireBytes: 85 },
    ]) {
      await expect(checkCiphertextUploadReceipt({ saved,
        csrfToken: "fictional-csrf", fetcher: reply(200, body) }))
        .rejects.toBeInstanceOf(UploadReceiptMismatch);
    }
  });

  it("never interprets a missing, denied or unavailable receipt as safe to retry", async () => {
    await expect(checkCiphertextUploadReceipt({ saved, csrfToken: "fictional-csrf",
      fetcher: reply(202, { status: "unconfirmed" }) }))
      .resolves.toBe("unconfirmed");
    for (const status of [401, 403, 404, 500]) {
      await expect(checkCiphertextUploadReceipt({ saved,
        csrfToken: "fictional-csrf", fetcher: reply(status, { error: "x" }) }))
        .rejects.toBeInstanceOf(UploadReceiptUnavailable);
    }
    await expect(checkCiphertextUploadReceipt({ saved, csrfToken: "fictional-csrf",
      fetcher: vi.fn(async () => { throw new Error("network lost"); }) }))
      .rejects.toBeInstanceOf(UploadReceiptUnavailable);
    await expect(checkCiphertextUploadReceipt({ saved, csrfToken: "fictional-csrf",
      fetcher: vi.fn(async () => new Response("{", { status: 200 })) }))
      .rejects.toBeInstanceOf(UploadReceiptUnavailable);
    await expect(checkCiphertextUploadReceipt({ saved, csrfToken: "fictional-csrf",
      fetcher: vi.fn(async () => ({ status: 200, redirected: true,
        json: async () => ({ status: "committed", wireSha256: saved.wireSha256,
          wireBytes: saved.wireBytes }) } as Response)) }))
      .rejects.toBeInstanceOf(UploadReceiptUnavailable);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(checkCiphertextUploadReceipt({ saved, csrfToken: "fictional-csrf",
      signal: cancelled.signal,
      fetcher: reply(200, { status: "committed", wireSha256: saved.wireSha256,
        wireBytes: saved.wireBytes }) }))
      .rejects.toBeInstanceOf(UploadReceiptUnavailable);
  });
});
