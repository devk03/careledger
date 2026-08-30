import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const widths = [320, 375, 414, 768];

for (const width of widths) {
  test(`caregiver entry is accessible without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1024 });
    await page.route("**/api/system/setup-status", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ setup_required: true, ai_available: true }),
      });
    });
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Know what is happening. Know what to ask next." }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Finish private setup" })).toBeVisible();

    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(sizes.document).toBe(sizes.viewport);
    expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);

    const wrappingAffordances = await page.locator("a, button").evaluateAll((elements) =>
      elements
        .filter((element) => window.getComputedStyle(element).whiteSpace !== "nowrap")
        .map((element) => element.textContent?.trim())
        .filter(Boolean),
    );
    expect(wrappingAffordances).toEqual([]);

    const accessibility = await new AxeBuilder({ page }).analyze();
    const materialViolations = accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(materialViolations).toEqual([]);
  });
}
