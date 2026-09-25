import { decodeManagedVaultBlobV2 } from "@adeno/contracts";

import { decryptManagedVaultBlobV2, ManagedVaultIntegrityV2Error,
  type ManagedVaultScopeV2 } from "../crypto/managedVaultV2";
import { generateVaultKeyMaterial, importVaultKey } from "../crypto/vault";
import { InvalidLocalDraft, prepareLocalEncryptedDraft,
  type LocalDraftIdentity } from "./intakeDraft";

const identity: LocalDraftIdentity = {
  householdId: "11".repeat(16), careProfileId: "22".repeat(16),
  opaqueDraftId: "33".repeat(16), keyEpoch: 1,
};
const reservedBlobIds = { content: "66".repeat(16), metadata: "77".repeat(16) };
const selectedAt = "2026-04-09T12:00:00.000Z";
const careDay = "2026-04-07";
const fictionalPdf = new TextEncoder().encode(
  "%PDF-1.4\nFICTIONAL_DOCUMENT_NOT_A_REAL_RECORD\n");

async function draftKey(): Promise<CryptoKey> {
  const material = generateVaultKeyMaterial();
  try { return await importVaultKey(material); }
  finally { material.fill(0); }
}

function localFile(name: string, bytes: Uint8Array) {
  const buffer = Uint8Array.from(bytes).buffer;
  return { name, size: buffer.byteLength,
    arrayBuffer: async () => buffer };
}

function scope(objectId: string): ManagedVaultScopeV2 {
  return { householdId: identity.householdId,
    careProfileId: identity.careProfileId,
    opaqueScopeId: identity.opaqueDraftId,
    objectId, keyEpoch: 1, purpose: "review-draft", revision: 1 };
}

async function open(key: CryptoKey, wire: Uint8Array, objectId: string) {
  return decryptManagedVaultBlobV2(key, decodeManagedVaultBlobV2(wire), scope(objectId));
}

it("protects two fictional files for one candidate care day without using selection time as care time", async () => {
  const key = await draftKey();
  const firstFile = localFile("fictional-visit.pdf", fictionalPdf);
  const secondFile = localFile("fictional-result.pdf", fictionalPdf);
  const first = await prepareLocalEncryptedDraft({ kind: "file", key, identity,
    reservedBlobIds,
    file: firstFile, clientSelectedAt: selectedAt, candidateCareDays: [careDay] });
  const second = await prepareLocalEncryptedDraft({ kind: "file", key,
    identity: { ...identity, opaqueDraftId: "44".repeat(16) },
    reservedBlobIds: { content: "88".repeat(16), metadata: "99".repeat(16) },
    file: secondFile, clientSelectedAt: selectedAt, candidateCareDays: [careDay] });
  for (const [draft, name, draftId] of [
    [first, firstFile.name, identity.opaqueDraftId],
    [second, secondFile.name, "44".repeat(16)],
  ] as const) {
    expect(draft.opaqueDraftId).toBe(draftId);
    expect(draft.contentBlobId).toBe(draft === first ? reservedBlobIds.content :
      "88".repeat(16));
    expect(draft.metadataBlobId).toBe(draft === first ? reservedBlobIds.metadata :
      "99".repeat(16));
    const wireId = (wire: Uint8Array) => [...decodeManagedVaultBlobV2(wire).blobId]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(wireId(draft.contentWire)).toBe(draft.contentBlobId);
    expect(wireId(draft.metadataWire)).toBe(draft.metadataBlobId);
    for (const wire of [draft.contentWire, draft.metadataWire]) {
      const text = new TextDecoder().decode(wire);
      expect(text).not.toContain(name);
      expect(text).not.toContain(careDay);
      expect(text).not.toContain("FICTIONAL_DOCUMENT");
    }
    const localScope = { ...scope(draft.contentObjectId), opaqueScopeId: draftId };
    const content = await decryptManagedVaultBlobV2(key,
      decodeManagedVaultBlobV2(draft.contentWire), localScope);
    expect(new TextDecoder().decode(content))
      .toContain("FICTIONAL_DOCUMENT_NOT_A_REAL_RECORD");
    const metadata = JSON.parse(new TextDecoder().decode(
      await decryptManagedVaultBlobV2(key,
        decodeManagedVaultBlobV2(draft.metadataWire),
        { ...scope(draft.metadataObjectId), opaqueScopeId: draftId }))) as
      Record<string, unknown>;
    expect(metadata).toMatchObject({ kind: "file", originalName: name,
      mediaType: "application/pdf", clientSelectedAt: selectedAt,
      candidateCareDays: [careDay], contentBlobId: draft.contentBlobId });
    expect(metadata).not.toHaveProperty("uploadedAt");
  }
  expect(new TextDecoder().decode(new Uint8Array(await firstFile.arrayBuffer())))
    .toContain("FICTIONAL_DOCUMENT_NOT_A_REAL_RECORD");
});

it("keeps an undated family note and its author inside ciphertext", async () => {
  const key = await draftKey();
  const body = "Fictional family observation, not a clinical conclusion.";
  const draft = await prepareLocalEncryptedDraft({ kind: "family_note", key,
    identity, reservedBlobIds, body, authorLabel: "Fictional adult",
    clientSelectedAt: selectedAt,
    candidateCareDays: [] });
  expect(new TextDecoder().decode(draft.contentWire)).not.toContain(body);
  expect(new TextDecoder().decode(draft.metadataWire)).not.toContain("Fictional adult");
  expect(new TextDecoder().decode(await open(key, draft.contentWire,
    draft.contentObjectId))).toBe(body);
  const metadata = JSON.parse(new TextDecoder().decode(await open(key,
    draft.metadataWire, draft.metadataObjectId))) as Record<string, unknown>;
  expect(metadata).toMatchObject({ kind: "family_note", authorLabel: "Fictional adult",
    candidateCareDays: [], clientSelectedAt: selectedAt });
  expect(metadata).not.toHaveProperty("uploadedAt");
});

it("snapshots dates, author, and scope before any asynchronous file or crypto work", async () => {
  const key = await draftKey();
  const draftIdentity = { ...identity };
  const input = { kind: "family_note" as const, key, identity: draftIdentity,
    reservedBlobIds: { ...reservedBlobIds },
    body: "Fictional original observation", authorLabel: "Fictional adult",
    clientSelectedAt: selectedAt, candidateCareDays: [careDay] };
  const pending = prepareLocalEncryptedDraft(input);
  input.body = "Changed after call";
  input.authorLabel = "Changed author";
  input.candidateCareDays.length = 0;
  draftIdentity.opaqueDraftId = "ee".repeat(16);
  input.reservedBlobIds.content = "ff".repeat(16);
  const draft = await pending;
  expect(draft.opaqueDraftId).toBe(identity.opaqueDraftId);
  expect(draft.contentBlobId).toBe(reservedBlobIds.content);
  expect(new TextDecoder().decode(await open(key, draft.contentWire,
    draft.contentObjectId))).toBe("Fictional original observation");
  const metadata = JSON.parse(new TextDecoder().decode(await open(key,
    draft.metadataWire, draft.metadataObjectId))) as Record<string, unknown>;
  expect(metadata).toMatchObject({ authorLabel: "Fictional adult",
    candidateCareDays: [careDay] });
});

it("rejects wrong draft scope, malformed dates, spoofed file bytes and oversize before reading", async () => {
  const key = await draftKey();
  const draft = await prepareLocalEncryptedDraft({ kind: "file", key, identity,
    reservedBlobIds,
    file: localFile("fictional.pdf", fictionalPdf), clientSelectedAt: selectedAt,
    candidateCareDays: [careDay] });
  await expect(decryptManagedVaultBlobV2(key,
    decodeManagedVaultBlobV2(draft.contentWire),
    { ...scope(draft.contentObjectId), opaqueScopeId: "55".repeat(16) }))
    .rejects.toBeInstanceOf(ManagedVaultIntegrityV2Error);
  for (const invalidDay of ["2026-02-30", "04/07/2026", selectedAt]) {
    await expect(prepareLocalEncryptedDraft({ kind: "family_note", key,
      identity, reservedBlobIds, body: "Fictional note",
      authorLabel: "Fictional adult",
      clientSelectedAt: selectedAt, candidateCareDays: [invalidDay] }))
      .rejects.toBeInstanceOf(InvalidLocalDraft);
  }
  await expect(prepareLocalEncryptedDraft({ kind: "file", key, identity,
    reservedBlobIds,
    file: localFile("fake.pdf", new TextEncoder().encode("not a PDF")),
    clientSelectedAt: selectedAt, candidateCareDays: [] }))
    .rejects.toBeInstanceOf(InvalidLocalDraft);
  let read = false;
  await expect(prepareLocalEncryptedDraft({ kind: "file", key, identity,
    reservedBlobIds,
    file: { name: "too-big.pdf", size: 100 * 1024 * 1024 + 1,
      arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } },
    clientSelectedAt: selectedAt, candidateCareDays: [] }))
    .rejects.toBeInstanceOf(InvalidLocalDraft);
  expect(read).toBe(false);
  const malformed = { content: 42, metadata: reservedBlobIds.metadata } as unknown as
    { content: string; metadata: string };
  await expect(prepareLocalEncryptedDraft({ kind: "file", key, identity,
    reservedBlobIds: malformed,
    file: { name: "fictional.pdf", size: fictionalPdf.byteLength,
      arrayBuffer: async () => { read = true; return fictionalPdf.buffer; } },
    clientSelectedAt: selectedAt, candidateCareDays: [] }))
    .rejects.toBeInstanceOf(InvalidLocalDraft);
  expect(read).toBe(false);
  await expect(prepareLocalEncryptedDraft({ kind: "family_note", key, identity,
    reservedBlobIds: { content: reservedBlobIds.content,
      metadata: reservedBlobIds.content }, body: "Fictional note",
    authorLabel: "Fictional adult", clientSelectedAt: selectedAt,
    candidateCareDays: [] })).rejects.toBeInstanceOf(InvalidLocalDraft);
});
