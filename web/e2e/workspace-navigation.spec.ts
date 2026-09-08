import { expect, test } from "@playwright/test";

for (const width of [375, 1280]) {
  test(`workspace navigation opens real views at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/public/project", route => route.fulfill({ json: { stars: null } }));
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Workspace sections" });
    await nav.getByRole("link", { name: "Records", exact: true }).click();
    await expect(page).toHaveURL(/\/records$/);
    await expect(page.getByRole("heading", { name: "Add records without losing where anything came from." })).toBeVisible();
    await page.goto("/");
    await page.getByRole("navigation", { name: "Workspace sections" }).getByRole("link", { name: "Next steps", exact: true }).click();
    await expect(page).toHaveURL(/\/workspace#next-steps$/);
    const heading = page.getByRole("heading", { name: "Questions for clinicians" });
    await expect(heading).toBeInViewport();
    await expect(page.locator("#next-steps")).toBeFocused();
  });
}
