import { expect, test } from "@playwright/test";

test("fictional file selection stays on device and becomes an encrypted local draft", async ({ page }) => {
  await page.goto("/design-system");
  const requests: { url: string; method: string; body: string | null }[] = [];
  page.on("request", (request) => requests.push({ url: request.url(),
    method: request.method(), body: request.postData() }));
  const result = await page.evaluate(async () => {
    const { prepareLocalEncryptedDraft } =
      await import("/src/managed/intakeDraft.ts");
    const { generateVaultKeyMaterial, importVaultKey } =
      await import("/src/crypto/vault.ts");
    const { decryptManagedVaultBlobV2 } =
      await import("/src/crypto/managedVaultV2.ts");
    const { decodeManagedVaultBlobV2 } =
      await import("/src/crypto/managedVaultWireV2.ts");
    const material = generateVaultKeyMaterial();
    const key = await importVaultKey(material);
    material.fill(0);
    const marker = "FICTIONAL_LOCAL_FILE_NOT_A_REAL_RECORD";
    const file = new File([`%PDF-1.4\n${marker}\n`], "fictional-care.pdf",
      { type: "application/pdf" });
    const identity = { householdId: "a".repeat(32), careProfileId: "b".repeat(32),
      opaqueDraftId: "c".repeat(32), keyEpoch: 1 };
    const selectedAt = "2026-04-09T12:00:00.000Z";
    const candidateCareDays = ["2026-04-07"];
    const draft = await prepareLocalEncryptedDraft({ kind: "file", file, key,
      identity, clientSelectedAt: selectedAt, candidateCareDays });
    const scope = (objectId: string) => ({ householdId: identity.householdId,
      careProfileId: identity.careProfileId, opaqueScopeId: identity.opaqueDraftId,
      objectId, keyEpoch: 1, purpose: "review-draft" as const, revision: 1 });
    const content = await decryptManagedVaultBlobV2(key,
      decodeManagedVaultBlobV2(draft.contentWire), scope(draft.contentObjectId));
    const metadata = JSON.parse(new TextDecoder().decode(
      await decryptManagedVaultBlobV2(key,
        decodeManagedVaultBlobV2(draft.metadataWire),
        scope(draft.metadataObjectId)))) as Record<string, unknown>;
    return { contentRestored: new TextDecoder().decode(content).includes(marker),
      contentWireHasMarker: new TextDecoder().decode(draft.contentWire).includes(marker),
      metadataWireHasName: new TextDecoder().decode(draft.metadataWire)
        .includes("fictional-care.pdf"),
      selectedAt: metadata.clientSelectedAt,
      candidateCareDays: metadata.candidateCareDays,
      uploadTimeInvented: Object.hasOwn(metadata, "uploadedAt"),
      keyExtractable: key.extractable };
  });
  expect(result).toEqual({ contentRestored: true, contentWireHasMarker: false,
    metadataWireHasName: false, selectedAt: "2026-04-09T12:00:00.000Z",
    candidateCareDays: ["2026-04-07"], uploadTimeInvented: false,
    keyExtractable: false });
  expect(requests.filter((request) => request.method !== "GET")).toEqual([]);
  expect(requests.some((request) => request.url.includes("/api/v3/vault/") ||
    request.url.includes("/api/care-profiles/"))).toBe(false);
  expect(requests.some((request) => (request.url + (request.body ?? ""))
    .includes("FICTIONAL_LOCAL_FILE"))).toBe(false);
});
