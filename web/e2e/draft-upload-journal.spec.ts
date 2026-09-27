import { expect, test } from "@playwright/test";

test("fictional draft upload journal survives reload and never re-sends an attempted role", async ({ page }) => {
  await page.goto("/design-system");
  const marker = "FICTIONAL_JOURNAL_NOTE_NOT_A_REAL_RECORD";
  const fixture = await page.evaluate(async (body) => {
    const { prepareLocalEncryptedDraft } = await import(
      "/src/managed/intakeDraft.ts");
    const { generateVaultKeyMaterial, importVaultKey } = await import(
      "/src/crypto/vault.ts");
    const { savePreparedDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    const material = generateVaultKeyMaterial();
    const key = await importVaultKey(material);
    material.fill(0);
    const tuple = { householdId: "a".repeat(32), accountId: "b".repeat(32),
      sessionId: "c".repeat(32), reservationId: "d".repeat(32) };
    const ids = { contentIntentId: "e".repeat(32),
      metadataIntentId: "f".repeat(32), contentBlobId: "1".repeat(32),
      metadataBlobId: "2".repeat(32) };
    const draft = await prepareLocalEncryptedDraft({ kind: "family_note",
      body, authorLabel: "Fictional adult", key,
      identity: { householdId: tuple.householdId,
        careProfileId: "3".repeat(32), opaqueDraftId: "4".repeat(32),
        keyEpoch: 1 }, reservedBlobIds: {
        content: ids.contentBlobId, metadata: ids.metadataBlobId },
      clientSelectedAt: "2026-09-01T12:00:00.000Z",
      candidateCareDays: ["2026-09-01"] });
    const saved = await savePreparedDraftUpload({ ...tuple, ...ids,
      contentWire: draft.contentWire,
      metadataWire: draft.metadataWire });
    return { tuple, ids, saved, contentWire: Array.from(draft.contentWire),
      metadataWire: Array.from(draft.metadataWire),
      raw: localStorage.getItem("adeno:managed:draft-upload:v1:" +
        [tuple.householdId, tuple.accountId, tuple.sessionId,
          tuple.reservationId].join(":")) };
  }, marker);
  expect(fixture.raw).not.toContain(marker);
  expect(fixture.raw).not.toContain("2026-09-01");
  expect(fixture.saved.contentState).toBe("prepared");
  await page.reload();
  const loaded = await page.evaluate(async (tuple) => {
    const { loadPreparedDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    return loadPreparedDraftUpload(tuple);
  }, fixture.tuple);
  expect(loaded).toEqual(fixture.saved);
  const unrelated = await page.evaluate(async (tuple) => {
    const { loadPreparedDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    return loadPreparedDraftUpload({ ...tuple,
      householdId: "9".repeat(32) });
  }, fixture.tuple);
  expect(unrelated).toBeNull();
  const posts = { content: 0, metadata: 0 };
  await page.context().route("**/api/v3/vault/intents/**", async (route) => {
    const url = route.request().url();
    const content = url.includes(fixture.ids.contentIntentId);
    const role = content ? "content" : "metadata";
    if (url.endsWith("/receipt")) {
      if (content) await route.fulfill({ status: 200,
        contentType: "application/json", body: JSON.stringify({
          status: "committed", wireSha256: fixture.saved.contentWireSha256,
          wireBytes: fixture.saved.contentWireBytes }) });
      else await route.fulfill({ status: 202,
        contentType: "application/json", body: JSON.stringify({
          status: "unconfirmed" }) });
      return;
    }
    posts[role] += 1;
    if (content) await route.abort("failed");
    else await route.fulfill({ status: 409,
      contentType: "application/json", body: "{}" });
  });
  const attempt = (role: "content" | "metadata") => page.evaluate(
    async ({ tuple, role, wire }) => {
      const { attemptDraftUploadRole } = await import(
        "/src/managed/draftUploadJournal.ts");
      return attemptDraftUploadRole({ tuple, role,
        wire: Uint8Array.from(wire),
        csrfToken: `v1.${"A".repeat(32)}.${"a".repeat(64)}` });
    }, { tuple: fixture.tuple, role,
      wire: role === "content" ? fixture.contentWire : fixture.metadataWire });
  const missingCsrfDenied = await page.evaluate(async ({ tuple, wire }) => {
    const { attemptDraftUploadRole, loadPreparedDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    try { await attemptDraftUploadRole({ tuple, role: "content",
      wire: Uint8Array.from(wire), csrfToken: "" });
      return false;
    } catch { return loadPreparedDraftUpload(tuple)?.contentState ===
      "prepared"; }
  }, { tuple: fixture.tuple, wire: fixture.contentWire });
  expect(missingCsrfDenied).toBe(true);
  expect(posts.content).toBe(0);
  const tampered = [...fixture.contentWire];
  tampered[tampered.length - 1] ^= 1;
  const tamperDenied = await page.evaluate(async ({ tuple, wire }) => {
    const { attemptDraftUploadRole } = await import(
      "/src/managed/draftUploadJournal.ts");
    try { await attemptDraftUploadRole({ tuple, role: "content",
      wire: Uint8Array.from(wire),
      csrfToken: `v1.${"A".repeat(32)}.${"a".repeat(64)}` });
      return false;
    } catch { return true; }
  }, { tuple: fixture.tuple, wire: tampered });
  expect(tamperDenied).toBe(true);
  expect(posts.content).toBe(0);
  const secondTab = await page.context().newPage();
  await secondTab.goto("/design-system");
  const lockName = "adeno:managed:draft-upload:v1:" +
    [fixture.tuple.householdId, fixture.tuple.accountId,
      fixture.tuple.sessionId, fixture.tuple.reservationId].join(":");
  await page.evaluate((name) => {
    const state = window as unknown as { journalLockEntered: boolean;
      releaseJournalLock?: () => void };
    state.journalLockEntered = false;
    void navigator.locks.request(name, { mode: "exclusive" }, async () => {
      state.journalLockEntered = true;
      await new Promise<void>((resolve) => {
        state.releaseJournalLock = resolve;
      });
    });
  }, lockName);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { journalLockEntered: boolean })
      .journalLockEntered)).toBe(true);
  const competing = secondTab.evaluate(async ({ tuple, wire }) => {
    const { attemptDraftUploadRole } = await import(
      "/src/managed/draftUploadJournal.ts");
    return attemptDraftUploadRole({ tuple, role: "content",
      wire: Uint8Array.from(wire),
      csrfToken: `v1.${"A".repeat(32)}.${"a".repeat(64)}` });
  }, { tuple: fixture.tuple, wire: fixture.contentWire });
  const first = attempt("content");
  await expect.poll(() => page.evaluate(async (name) => {
    const state = await navigator.locks.query();
    return state.pending?.filter((entry) => entry.name === name).length ?? 0;
  }, lockName)).toBe(2);
  expect(posts.content).toBe(0);
  await page.evaluate(() =>
    (window as unknown as { releaseJournalLock: () => void })
      .releaseJournalLock());
  expect(await Promise.all([first, competing]))
    .toEqual(["committed", "committed"]);
  await secondTab.close();
  expect(await attempt("metadata")).toBe("unconfirmed");
  expect(posts).toEqual({ content: 1, metadata: 1 });
  expect(await attempt("content")).toBe("committed");
  expect(await attempt("metadata")).toBe("unconfirmed");
  expect(posts).toEqual({ content: 1, metadata: 1 });
  await page.reload();
  const reconciled = await page.evaluate(async (tuple) => {
    const { reconcileDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    return reconcileDraftUpload({ tuple,
      csrfToken: `v1.${"A".repeat(32)}.${"a".repeat(64)}` });
  }, fixture.tuple);
  expect(reconciled).toEqual({ content: "committed",
    metadata: "unconfirmed" });
  expect(posts).toEqual({ content: 1, metadata: 1 });
  const after = await page.evaluate(async (tuple) => {
    const { loadPreparedDraftUpload } = await import(
      "/src/managed/draftUploadJournal.ts");
    return loadPreparedDraftUpload(tuple);
  }, fixture.tuple);
  expect(after?.contentState).toBe("attempted");
  expect(after?.metadataState).toBe("attempted");
});
