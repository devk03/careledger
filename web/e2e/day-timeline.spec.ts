import { expect, test } from "@playwright/test";

for (const width of [375, 1280]) {
  test(`fictional day cards hold multiple files at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/design-system");
    const timeline = page.getByRole("region", { name: "One day at a time." });
    await expect(timeline.locator("details")).toHaveCount(2);
    await expect(timeline.getByText("2 files · 1 note")).toBeVisible();
    await expect(timeline.getByText(/Date unclear: 1 item needs/)).toBeVisible();
    await timeline.getByText("Friday, April 12, 2030").click();
    await expect(timeline.getByText("fictional-visit.pdf")).toBeVisible();
    await expect(timeline.getByText("fictional-lab.pdf")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
