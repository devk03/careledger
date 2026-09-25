import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeManagedVaultBlobV2, MANAGED_VAULT_CHUNK_BYTES,
  MANAGED_VAULT_FORMAT_V2 } from "@adeno/contracts";
import { describe, expect, it } from "vitest";

import type { VerifiedSession } from "../src/auth/cookieSession.js";
import { ManagedVaultUploadDeniedError } from
  "../src/managed/ciphertextAdmission.js";
import { CiphertextObjectIntegrityError } from
  "../src/managed/ciphertextObjectStore.js";
import { createStagedManagedVaultUploadStore, type ManagedStagingIntent,
  type ManagedUploadLedger } from "../src/managed/stagedUploadStore.js";

const householdId = "11".repeat(16);
const intentId = "22".repeat(16);
const blobId = "33".repeat(16);
const accountId = "adult-fictional-a";
const sessionId = "session-fictional-a";
const preflight = { tokenSha256: "44".repeat(32), csrfToken: "fictional-csrf" };
const session: VerifiedSession = { scope: { householdId, userId: accountId },
  sessionId, csrfSecret: Buffer.alloc(32, 0x55), expiresAt: 9_999_999_999 };

function fictionalUpload() {
  const iv = Buffer.alloc(12, 0x66);
  const ciphertext = Buffer.alloc(19, 0x77); // Framing fixture, not AES-GCM.
  const wire = Buffer.from(encodeManagedVaultBlobV2({ format: MANAGED_VAULT_FORMAT_V2,
    blobId: Buffer.from(blobId, "hex"), plaintextSize: 3,
    chunkSize: MANAGED_VAULT_CHUNK_BYTES,
    chunks: [{ iv, ciphertext: Uint8Array.from(ciphertext).buffer }] }));
  const header = { wireVersion: 2 as const, blobId, plaintextSize: 3,
    chunkCount: 1, expectedWireBytes: wire.length };
  return { iv, ciphertext, wire, header,
    sha256: createHash("sha256").update(wire).digest("hex") };
}

async function fixture(overrides: Partial<ManagedStagingIntent> = {},
  ledgerOverride: Partial<ManagedUploadLedger> = {}) {
  const objectRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-stage-"));
  const intent: ManagedStagingIntent = { householdId, accountId, sessionId,
    intentId, blobId, plaintextBytes: 3, chunkCount: 1, ...overrides };
  const published: Parameters<ManagedUploadLedger["publishVerified"]>[0][] = [];
  const ledger: ManagedUploadLedger = {
    openForStaging: async () => intent,
    publishVerified: async (value) => { published.push(value); },
    ...ledgerOverride,
  };
  const store = createStagedManagedVaultUploadStore({ objectRoot, ledger });
  const controller = new AbortController();
  return { objectRoot, intent, published, store, controller };
}

describe("unmounted managed ciphertext staging adapter", () => {
  it("publishes only re-read object metadata and the exact received-wire digest", async () => {
    const test = await fixture();
    const opened = await test.store.open({ session, preflight, intentId,
      signal: test.controller.signal });
    expect(opened?.expectedBlobId).toBe(blobId);
    const upload = fictionalUpload();
    await opened!.sink.begin(upload.header);
    await opened!.sink.append({ index: 0, iv: upload.iv,
      ciphertext: upload.ciphertext });
    await opened!.sink.commit(upload.header, upload.sha256, test.controller.signal);
    expect(test.published).toHaveLength(1);
    expect(test.published[0]!.wireSha256).toEqual(Buffer.from(upload.sha256, "hex"));
    expect(test.published[0]!.wireBytes).toBe(upload.wire.length);
    expect(test.published[0]!.chunks).toHaveLength(1);
    expect(test.published[0]!.chunks[0]!.ciphertextSha256).toEqual(
      createHash("sha256").update(upload.ciphertext).digest());
    expect(test.published[0]!.chunks[0]!.storageObjectId)
      .toMatch(/^[0-9a-f]{32}$/u);
    expect(test.published[0]!.tokenSha256).toBe(preflight.tokenSha256);
  });

  it("never calls the ledger when staged object bytes change before commit", async () => {
    const test = await fixture();
    const opened = await test.store.open({ session, preflight, intentId,
      signal: test.controller.signal });
    const upload = fictionalUpload();
    await opened!.sink.begin(upload.header);
    await opened!.sink.append({ index: 0, iv: upload.iv,
      ciphertext: upload.ciphertext });
    const digest = createHash("sha256").update(householdId).digest("hex");
    const directory = join(test.objectRoot, digest.slice(0, 2), digest.slice(2, 4), digest);
    const storageId = (await readdir(directory)).find((entry) => /^[0-9a-f]{32}$/u.test(entry));
    expect(storageId).toBeDefined();
    const path = join(directory, storageId!);
    await chmod(path, 0o600);
    await writeFile(path, Buffer.alloc(upload.ciphertext.length, 0));
    await chmod(path, 0o400);
    await expect(opened!.sink.commit(upload.header, upload.sha256,
      test.controller.signal)).rejects.toBeInstanceOf(CiphertextObjectIntegrityError);
    expect(test.published).toHaveLength(0);
  });

  it("rejects an intent for another family before staging bytes", async () => {
    const test = await fixture({ householdId: "aa".repeat(16) });
    await expect(test.store.open({ session, preflight, intentId,
      signal: test.controller.signal })).rejects.toBeInstanceOf(
      ManagedVaultUploadDeniedError);
    expect(test.published).toHaveLength(0);
  });

  it("aborts an in-flight publish and forwards cancellation to the ledger", async () => {
    let started!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { started = resolve; });
    let completed = false;
    const ledgerSignals: AbortSignal[] = [];
    const test = await fixture({}, { publishVerified: async ({ signal }) => {
      ledgerSignals.push(signal);
      started();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      completed = true;
    } });
    const opened = await test.store.open({ session, preflight, intentId,
      signal: test.controller.signal });
    const upload = fictionalUpload();
    await opened!.sink.begin(upload.header);
    await opened!.sink.append({ index: 0, iv: upload.iv,
      ciphertext: upload.ciphertext });
    const committing = opened!.sink.commit(upload.header, upload.sha256,
      test.controller.signal);
    await publicationStarted;
    await opened!.sink.abort();
    await expect(committing).rejects.toThrow();
    expect(ledgerSignals[0]?.aborted).toBe(true);
    expect(completed).toBe(false);
    expect(test.published).toHaveLength(0);
  });

  it("bounds an unresponsive ledger open before accepting upload bytes", async () => {
    const objectRoot = await mkdtemp(join(tmpdir(), "adeno-fictional-timeout-"));
    const ledger: ManagedUploadLedger = {
      openForStaging: async () => new Promise<ManagedStagingIntent>(() => undefined),
      publishVerified: async () => { throw new Error("must not publish"); },
    };
    const store = createStagedManagedVaultUploadStore({ objectRoot, ledger,
      openDeadlineMs: 25 });
    await expect(store.open({ session, preflight, intentId,
      signal: new AbortController().signal })).rejects.toThrow("unavailable");
  });
});
