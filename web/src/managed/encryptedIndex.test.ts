import { encodeManagedVaultBlobV2 } from "@adeno/contracts";

import { encryptManagedVaultBlobV2, type ManagedVaultScopeV2 } from
  "../crypto/managedVaultV2";
import { generateIndexSigningKeys, signLocalIndexHead,
  type IndexHeadCandidate, type IndexViewIdentity } from
  "../crypto/signedIndexHead";
import { generateVaultKeyMaterial, importVaultKey } from "../crypto/vault";
import { DecryptedTimelineChanged, type DecryptedTimelineEntry } from "./timeline";
import { encodeLocalApprovedIndex, EncryptedIndexIntegrityError,
  openLocalApprovedIndex, sealLocalApprovedIndex } from "./encryptedIndex";

const identity: IndexViewIdentity = { householdId: "11".repeat(16),
  careProfileId: "22".repeat(16), viewId: "33".repeat(16),
  indexKeyId: "44".repeat(16), keyEpoch: 1 };
const objectId = "55".repeat(16);
const deviceId = "66".repeat(16);
const grantHead = "77".repeat(32);
const marker = "FICTIONAL_INDEX_NOTE_NOT_A_REAL_RECORD";
const entries: DecryptedTimelineEntry[] = [
  { id: "a".repeat(32), careProfileId: identity.careProfileId,
    receivedAt: "2030-05-01T10:00:00.000Z", careDays: ["2030-04-12"],
    reviewState: "approved", kind: "file", displayName: "fictional-visit.pdf",
    printedDate: { kind: "day", value: "2030-04-14" }, pageNumbers: [1] },
  { id: "b".repeat(32), careProfileId: identity.careProfileId,
    receivedAt: "2030-04-16T10:00:00.000Z", careDays: ["2030-04-12"],
    reviewState: "approved", kind: "family_note", body: marker,
    authorLabel: "Fictional adult", printedDate: null },
  { id: "c".repeat(32), careProfileId: identity.careProfileId,
    receivedAt: "2030-04-11T10:00:00.000Z", careDays: ["2030-04-09"],
    reviewState: "approved", kind: "file", displayName: "fictional-lab.png",
    printedDate: null, pageNumbers: [1] },
  { id: "d".repeat(32), careProfileId: identity.careProfileId,
    receivedAt: "2030-04-20T10:00:00.000Z", careDays: [],
    reviewState: "approved", kind: "family_note", body: "Undated fictional thought",
    authorLabel: "Fictional adult", printedDate: null },
];

async function vaultKey(): Promise<CryptoKey> {
  const material = generateVaultKeyMaterial();
  try { return await importVaultKey(material); }
  finally { material.fill(0); }
}

async function fixture() {
  const indexKey = await vaultKey();
  const signingKeys = await generateIndexSigningKeys();
  const scope = (revision: number, overrides: Partial<ManagedVaultScopeV2> = {}):
    ManagedVaultScopeV2 => ({ householdId: identity.householdId,
      careProfileId: identity.careProfileId, opaqueScopeId: identity.viewId,
      objectId, keyEpoch: identity.keyEpoch, purpose: "encrypted-index",
      revision, ...overrides });
  async function seal(input: { entries?: DecryptedTimelineEntry[];
    previous?: IndexHeadCandidate | null; payload?: Uint8Array;
    scopeChange?: Partial<ManagedVaultScopeV2> } = {}) {
    const previous = input.previous ?? null;
    const sequence = previous ? previous.sequence + 1n : 1n;
    if (!input.payload && !input.scopeChange) {
      const result = await sealLocalApprovedIndex({ identity, objectId,
        reservedBlobId: crypto.getRandomValues(new Uint8Array(16)),
        entries: input.entries ?? entries, indexKey, authorDeviceId: deviceId,
        authorCounter: sequence, grantHeadSha256: grantHead, signingKeys,
        previous });
      return { ciphertextWire: result.ciphertextWire,
        signed: { wire: result.signedHeadWire,
          candidate: result.unpublishedCandidate } };
    }
    const plaintext = input.payload ?? encodeLocalApprovedIndex({ identity,
      objectId, sequence, entries: input.entries ?? entries });
    const ciphertextWire = encodeManagedVaultBlobV2(
      await encryptManagedVaultBlobV2(indexKey, plaintext,
        scope(Number(sequence), input.scopeChange)));
    const signed = await signLocalIndexHead({ identity, objectId,
      authorDeviceId: deviceId, authorCounter: sequence,
      grantHeadSha256: grantHead, ciphertextWire, signingKeys, previous });
    return { ciphertextWire, signed };
  }
  const open = (sealed: Awaited<ReturnType<typeof seal>>,
    checkpoint: IndexHeadCandidate, overrides: Partial<Parameters<
      typeof openLocalApprovedIndex>[0]> = {}) => openLocalApprovedIndex({
        signedHeadWire: sealed.signed.wire,
        ciphertextWire: sealed.ciphertextWire,
        expectedView: identity, expectedObjectId: objectId, indexKey,
        trustedSigner: { deviceId, publicKey: signingKeys.publicKey },
        trustedGrantHeadSha256: grantHead, checkpoint, ...overrides,
      });
  return { indexKey, signingKeys, seal, open };
}

it("opens a pinned encrypted snapshot and traverses care days, not upload dates", async () => {
  const test = await fixture();
  const first = await test.seal();
  expect(new TextDecoder().decode(first.ciphertextWire)).not.toContain(marker);
  expect(new TextDecoder().decode(first.signed.wire)).not.toContain("2030-04-12");
  const opened = await test.open(first, first.signed.candidate);
  expect(opened.state).toBe("unchanged");
  expect(opened.candidate).toEqual(first.signed.candidate);
  expect(opened.timeline.days.map(({ day }) => day)).toEqual([
    "2030-04-12", "2030-04-09",
  ]);
  expect(opened.timeline.days[0]?.entries).toHaveLength(2);
  expect(opened.timeline.undated.map(({ id }) => id)).toEqual(["d".repeat(32)]);
  const history = await opened.historyThroughDay("2030-04-12", { limit: 1 });
  expect(history.days.map(({ day }) => day)).toEqual(["2030-04-12"]);
  expect(history.nextCursor?.headSha256).toBe(first.signed.candidate.headSha256);
  const older = await opened.historyThroughDay("2030-04-12", {
    cursor: history.nextCursor!, limit: 1 });
  expect(older.days.map(({ day }) => day)).toEqual(["2030-04-09"]);
});

it("sees a late earlier-day addition and rejects a cursor from an older head", async () => {
  const test = await fixture();
  const first = await test.seal();
  const old = await test.open(first, first.signed.candidate);
  const firstPage = await old.historyThroughDay("2030-04-12", { limit: 1 });
  const late: DecryptedTimelineEntry = { id: "e".repeat(32),
    careProfileId: identity.careProfileId,
    receivedAt: "2030-06-02T11:00:00.000Z", careDays: ["2030-04-09"],
    reviewState: "approved", kind: "file", displayName: "fictional-late.jpg",
    printedDate: null, pageNumbers: [1] };
  const second = await test.seal({ previous: first.signed.candidate,
    entries: [...entries, late] });
  const newer = await test.open(second, first.signed.candidate);
  expect(newer.state).toBe("advanced");
  const earlier = await newer.historyThroughDay("2030-04-09");
  expect(earlier.days[0]?.entries).toHaveLength(2);
  await expect(newer.historyThroughDay("2030-04-12", {
    cursor: firstPage.nextCursor! })).rejects.toBeInstanceOf(
      DecryptedTimelineChanged);
});

it("rejects validly signed ciphertext under a different AES-GCM scope", async () => {
  const test = await fixture();
  for (const scopeChange of [
    { revision: 2 }, { purpose: "day-snapshot" as const },
    { opaqueScopeId: "aa".repeat(16) }, { objectId: "bb".repeat(16) },
    { careProfileId: "cc".repeat(16) }, { keyEpoch: 2 },
  ]) {
    const sealed = await test.seal({ scopeChange });
    await expect(test.open(sealed, sealed.signed.candidate))
      .rejects.toBeInstanceOf(EncryptedIndexIntegrityError);
  }
  const valid = await test.seal();
  await expect(test.open(valid, valid.signed.candidate, {
    expectedObjectId: "aa".repeat(16) }))
    .rejects.toBeInstanceOf(EncryptedIndexIntegrityError);
  await expect(test.open(valid, valid.signed.candidate, {
    expectedView: { ...identity, householdId: "bb".repeat(16) } }))
    .rejects.toBeInstanceOf(EncryptedIndexIntegrityError);
});

it("rejects malformed or pending entries even when ciphertext and signature are valid", async () => {
  const test = await fixture();
  const payload = JSON.parse(new TextDecoder().decode(encodeLocalApprovedIndex({
    identity, objectId, sequence: 1n, entries }))) as Record<string, unknown>;
  for (const changed of [
    { ...payload, entries: [...entries, { ...entries[0],
      reviewState: "pending" }] },
    { ...payload, entries: [...entries, entries[0]] },
    { ...payload, entries: [{ ...entries[0], careProfileId: "ff".repeat(16) }] },
    { ...payload, entries: [{ ...entries[0], unexpected: "field" }] },
    { ...payload, sequence: "2" },
    { ...payload, unexpected: "field" },
  ]) {
    const sealed = await test.seal({ payload: new TextEncoder().encode(
      JSON.stringify(changed)) });
    await expect(test.open(sealed, sealed.signed.candidate))
      .rejects.toBeInstanceOf(EncryptedIndexIntegrityError);
  }
  const duplicateJson = new TextEncoder().encode(
    '{"format":"adeno.approved-history-index.v1","format":"adeno.approved-history-index.v1"}');
  const duplicate = await test.seal({ payload: duplicateJson });
  await expect(test.open(duplicate, duplicate.signed.candidate))
    .rejects.toBeInstanceOf(EncryptedIndexIntegrityError);
  expect(() => encodeLocalApprovedIndex({ identity, objectId, sequence: 1n,
    entries: [...entries, { ...entries[0]!, reviewState: "pending" }] }))
    .toThrow(EncryptedIndexIntegrityError);
  expect(() => encodeLocalApprovedIndex({ identity, objectId,
    sequence: 0x100000000n, entries })).toThrow(EncryptedIndexIntegrityError);
});

it("does not let callers mutate the verified head or silently restart a bad cursor", async () => {
  const test = await fixture();
  const sealed = await test.seal();
  const opened = await test.open(sealed, sealed.signed.candidate);
  const first = await opened.historyThroughDay("2030-04-12", { limit: 1 });
  expect(Object.isFrozen(opened.candidate)).toBe(true);
  expect(() => { opened.candidate.headSha256 = "aa".repeat(32); }).toThrow();
  expect((await opened.historyThroughDay("2030-04-12", {
    cursor: first.nextCursor!, limit: 1 })).headSha256)
    .toBe(sealed.signed.candidate.headSha256);
  await expect(opened.historyThroughDay("2030-04-12", { cursor: {
    headSha256: sealed.signed.candidate.headSha256,
    history: undefined,
  } as unknown as NonNullable<typeof first.nextCursor> }))
    .rejects.toBeInstanceOf(DecryptedTimelineChanged);
});

it("snapshots the prior head and approved entries before asynchronous sealing", async () => {
  const test = await fixture();
  const first = await test.seal();
  const mutablePrevious = { ...first.signed.candidate };
  const mutableEntries = structuredClone(entries) as DecryptedTimelineEntry[];
  const pending = test.seal({ previous: mutablePrevious, entries: mutableEntries });
  mutablePrevious.sequence = 500n;
  mutablePrevious.headSha256 = "aa".repeat(32);
  const changed = mutableEntries[0]!;
  if (changed.kind !== "file") throw new Error("Expected fictional file");
  changed.displayName = "changed-after-seal.pdf";
  const second = await pending;
  expect(second.signed.candidate.sequence).toBe(2n);
  const opened = await test.open(second, first.signed.candidate);
  expect(opened.timeline.days[0]?.entries[0]?.kind).toBe("file");
  expect((opened.timeline.days[0]?.entries[0] as Extract<
    DecryptedTimelineEntry, { kind: "file" }>).displayName)
    .toBe("fictional-visit.pdf");
});

it("rejects a spoofed byte input and bounds cumulative writer allocation", async () => {
  const test = await fixture();
  const sealed = await test.seal();
  const spoofed = { [Symbol.toStringTag]: "Uint8Array", byteLength: 65,
    *[Symbol.iterator]() { while (true) yield 0; } } as unknown as Uint8Array;
  await expect(test.open(sealed, sealed.signed.candidate, {
    ciphertextWire: spoofed })).rejects.toBeInstanceOf(
      EncryptedIndexIntegrityError);
  const sharedBody = "F".repeat(20_000);
  const tooMany = Array.from({ length: 1000 }, (_, index):
    DecryptedTimelineEntry => ({ id: index.toString(16).padStart(32, "0"),
      careProfileId: identity.careProfileId,
      receivedAt: "2030-04-12T10:00:00.000Z", careDays: ["2030-04-12"],
      reviewState: "approved", kind: "family_note", body: sharedBody,
      authorLabel: "Fictional adult", printedDate: null }));
  expect(() => encodeLocalApprovedIndex({ identity, objectId, sequence: 1n,
    entries: tooMany })).toThrow(EncryptedIndexIntegrityError);
  let serializedNestedValue = false;
  const malformedPage = { toJSON() { serializedNestedValue = true;
    return "F".repeat(8_000_000); } };
  expect(() => encodeLocalApprovedIndex({ identity, objectId,
    sequence: 1n, entries: [{ ...entries[0]!,
      pageNumbers: [malformedPage] } as unknown as DecryptedTimelineEntry] }))
    .toThrow(EncryptedIndexIntegrityError);
  expect(serializedNestedValue).toBe(false);
});
