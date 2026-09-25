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
