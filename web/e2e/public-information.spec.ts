import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const width of [320, 1280]) {
  test(`public information links work at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/public/project", route => route.fulfill({ json: { stars: 7, stale: false } }));
    await page.goto("/");
    await expect(page.locator("button:disabled, a:not([href])")).toHaveCount(0);
    // Every apparent landing link has a real, non-empty destination; local hashes exist.
    for (const link of await page.locator("a").all()) {
      const href = await link.getAttribute("href");
      expect(href).toBeTruthy();
      expect(href).not.toBe("#");
      if (href?.startsWith("#")) await expect(page.locator(href)).toHaveCount(1);
    }
    const previewPrivacy = page.getByRole("complementary", { name: "Preview safety notice" })
      .getByRole("link", { name: "Read the privacy model" });
    await expect(previewPrivacy).toBeVisible();
    const bounds = await previewPrivacy.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await previewPrivacy.focus();
    await expect(previewPrivacy).toBeFocused();
    await previewPrivacy.click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.goBack();
    await page.getByRole("region", { name: "Safety principles" })
      .getByRole("link", { name: "Read the privacy model" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "The privacy model", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "The current server can read your records" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({ page }).analyze()).violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    await page.getByRole("navigation", { name: "Information navigation" }).getByRole("link", { name: "About adeno" }).click();
    await expect(page.getByRole("heading", { name: "A little more clarity for the person helping." })).toBeVisible();
    await expect(page.getByText(/Fictional examples—not testimonials/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "A helper for understanding—not a clinician" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await new AxeBuilder({ page }).analyze()).violations.filter(v => ["serious", "critical"].includes(v.impact ?? ""))).toEqual([]);
    await page.getByRole("link", { name: "Back to adeno" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole("link", { name: "Why we’re building adeno" }).click();
    await expect(page).toHaveURL(/\/about$/);
  });
}
