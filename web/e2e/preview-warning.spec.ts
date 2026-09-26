import { expect, test } from "@playwright/test";

test("the fictional-only warning remains visible at record intake after scrolling", async ({ page }) => {
  await page.goto("/records");
  const uploadWarning = page.getByLabel("Preview upload warning");
  const filePicker = page.getByText("Choose a PDF or clear photo");
  await expect(filePicker).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await filePicker.scrollIntoViewIfNeeded();
  await expect(uploadWarning).toBeInViewport();
  await expect(uploadWarning).toContainText("fictional records only");

  await page.setViewportSize({ width: 375, height: 667 });
  await filePicker.scrollIntoViewIfNeeded();
  await expect(uploadWarning).toBeInViewport();
});

test("server-readable community mode keeps its privacy notice at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 667 });
  await page.route("**/api/public/runtime", route => route.fulfill({
    json: { restricted_preview: false },
  }));
  await page.goto("/");
  const notice = page.getByRole("complementary", { name: "Record privacy notice" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("records are server-readable");
  await expect(notice).toContainText("not end-to-end encrypted");
  await expect(notice).not.toContainText("fictional records only");
  const privacyLink = notice.getByRole("link", { name: "Read the privacy model" });
  const bounds = await privacyLink.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(320);
  await page.goto("/records");
  await expect(page.getByLabel("Upload privacy notice")).toBeVisible();
});
