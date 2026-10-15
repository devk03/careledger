import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.use({ ...(process.env.ADENO_TEST_BROWSER_CHANNEL ? { channel: process.env.ADENO_TEST_BROWSER_CHANNEL } : {}) });

test("explains member scope and reporter provenance, and keeps both header rows readable", async ({ page, baseURL }, testInfo) => {
  const owner = { userId: "owner-a", displayName: "Invented owner" };
  const fileName = "2030-04-12_wholly-invented-long-source-document-PDF-PAGE-COPY-1.png";
  const file = { documentId: "file-a", displayName: fileName, sourceSha256: "a".repeat(64), mediaType: "image/png",
    uploadedAt: "2030-04-13T12:00:00Z", uploadedBy: owner, pageNumbers: [1], pageCount: 1,
    pendingDayProposals: [{ revisionId: "placement-a", careDay: "2030-04-12" }],
    provenance: { uploadedBy: owner, placement: { recordedBy: owner, recordedAt: "2030-04-13T12:00:00Z", reviewedBy: owner, reviewedAt: "2030-04-13T12:01:00Z" } } };
  let saved: unknown;
  await page.route(new URL("/api/**", baseURL!).href, async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path.endsWith("/public/runtime")) body = { mode: "trusted_private", restricted_preview: false };
    else if (path.endsWith("/auth/session")) body = { csrfToken: "invented-csrf" };
    else if (path.endsWith("/care-profiles")) body = { profiles: [{ id: "person-a", preferredName: "Invented person" }] };
    else if (path.endsWith("/family/access")) body = { visibility: "household", currentUserId: "owner-a", profiles: [{ id: "person-a", preferredName: "Invented person" }], members: [
      { id: "owner-a", displayName: "Invented owner", role: "owner", memberKind: "adult", status: "active", allProfiles: true, intakeProfiles: [], days: [], documents: [] },
      { id: "reader-a", displayName: "Invented reader", role: "caregiver", memberKind: "adult", status: "active", allProfiles: false, intakeProfiles: [],
        days: [{ careProfileId: "person-a", careDay: "2030-04-12", level: "view", grantedBy: owner, grantedAt: "2030-04-11T12:00:00Z" }],
        documents: [{ careProfileId: "person-a", documentId: "file-a", displayName: fileName, basis: "explicit_grant" }] },
      { id: "child-a", displayName: "Invented young caregiver", role: "caregiver", memberKind: "child", status: "active", allProfiles: false, intakeProfiles: ["person-a"], days: [], documents: [] },
    ] };
    else if (path.endsWith("/note-provenance/capabilities")) body = { available: true };
    else if (path.endsWith("/document-workflow/capabilities")) body = { available: true };
    else if (path.endsWith("/documents/inbox")) body = { documents: [file], nextCursor: null };
    else if (path.includes("/reviews/document-days/")) body = { ...file, revisionId: "placement-a", careDay: "2030-04-12", expectedDayRevision: 1, authorLabel: owner.displayName, createdAt: "2030-04-13T12:00:00Z", state: "proposed" };
    else if (path.endsWith("/notes/pending")) body = { pending: [] };
    else if (path.endsWith("/timeline/history")) body = { days: [{ id: "day-a", day: "2030-04-12", careProfileId: "person-a", revision: 1,
      publishedBy: owner, publishedAt: "2030-04-13T12:01:00Z", sources: [file], statements: [{ id: "note-a", text: "Wholly invented observation.", attribution: "family_note", authorLabel: owner.displayName, status: "uncertain",
        provenance: { reporterLabel: "Invented reporter", sourceKind: "document", sourceDescription: "Invented record, page 1.", recordedBy: owner, recordedAt: "2030-04-13T12:00:00Z", reviewedBy: owner, reviewedAt: "2030-04-13T12:01:00Z", citations: [{ documentId: "file-a", pageNumber: 1 }] } }] }], nextBeforeDay: null };
    else if (path.endsWith("/notes") && route.request().method() === "POST") { saved = route.request().postDataJSON(); body = { ok: true }; }
    else if (path.endsWith("/original-image")) {
      await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=", "base64") }); return;
    } else body = { available: false, mediaTypes: [], maxBytes: 0 };
    await route.fulfill({ json: body });
  });
  await page.goto("/pilot");
  await expect(page.getByRole("heading", { name: "People & permissions" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invented owner (you)" })).toBeVisible();
  await expect(page.getByText("No publishing days granted.", { exact: true })).toBeVisible();
  await expect(page.getByText("Not permitted for child accounts.", { exact: true })).toBeVisible();
  await page.getByText("Reporter & sources", { exact: true }).click();
  await expect(page.getByText("Invented reporter", { exact: true })).toBeVisible();
  await expect(page.getByText("Invented record, page 1.", { exact: true })).toBeVisible();
  for (const width of [1280, 768, 414, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const headerFits = await page.locator(".preview-safety-banner").evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll("span, a")).every(child => {
        const range = document.createRange(); range.selectNodeContents(child);
        return Array.from(range.getClientRects()).every(rect => rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right);
      });
    });
    expect(headerFits).toBe(true);
    const accountFits = await page.locator(".ui-header-actions").evaluate(element => element.scrollWidth <= element.clientWidth);
    expect(accountFits).toBe(true);
    await page.getByRole("banner").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`access-provenance-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByLabel("Reported by", { exact: true })).toBeVisible();
  await page.getByLabel("Care day", { exact: true }).fill("2030-04-14");
  await page.getByLabel("What you observed", { exact: true }).fill("Another invented observation.");
  await page.getByLabel("Reported by", { exact: true }).fill("Another invented reporter");
  await page.getByRole("combobox", { name: "Information source", exact: true }).selectOption("document");
  await page.getByLabel("Source details", { exact: true }).fill("Wholly invented source description.");
  await page.getByRole("combobox", { name: "Source file", exact: true }).selectOption("file-a");
  await page.locator(".pilot-note-source").screenshot({ path: testInfo.outputPath("note-source-fields.png") });
  await page.locator("#family-access").screenshot({ path: testInfo.outputPath("family-access-panel.png") });
  await page.getByRole("button", { name: "Save for review", exact: true }).click();
  await expect(page.getByText("Note saved as a proposal. Review it before publishing.")).toBeVisible();
  expect(saved).toEqual({ body: "Another invented observation.", provenance: { reporterLabel: "Another invented reporter", sourceKind: "document", sourceDescription: "Wholly invented source description.", documentId: "file-a", pageNumber: 1 } });
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
});
