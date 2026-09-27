import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const width of [320, 375, 414, 768, 1280]) {
  test(`public-only shell is honest and readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/public/project", (route) =>
      route.fulfill({ json: { stars: 7, checked_at: 1_800_000_000,
        stale: false } }));
    await page.goto("/");
    await expect(page.getByRole("heading", {
      name: "Adeno is being built in the open." })).toBeVisible();
    await expect(page.getByText("This hosted workspace is not open for records yet."))
      .toBeVisible();
    await expect(page.getByRole("link", { name: /adeno on GitHub, 7 stars/u }))
      .toHaveAttribute("href", "https://github.com/devk03/careledger");
    await expect(page.getByRole("link", { name: /Sign in|Upload|Add record/u }))
      .toHaveCount(0);
    expect(await page.locator("img").evaluateAll((images) => images.every(
      (image) => image instanceof HTMLImageElement && image.naturalWidth > 0)))
      .toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
    const violations = (await new AxeBuilder({ page }).analyze()).violations
      .filter((item) => ["serious", "critical"].includes(item.impact ?? ""));
    expect(violations).toEqual([]);
    await page.getByRole("link", { name: "About", exact: true }).click();
    await expect(page.getByRole("heading", { name: "About Adeno." })).toBeVisible();
    await page.getByRole("link", { name: "Privacy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Privacy, as it stands." }))
      .toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(width);
  });
}

test("server never routes record, auth, or MCP requests into the shell bundle", async ({ request }) => {
  for (const path of ["/records", "/login", "/setup", "/workspace",
    "/api/v2/auth/session", "/api/managed/auth/login", "/mcp"]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  }
  const ready = await request.get("/health/ready");
  expect(await ready.json()).toEqual({ status: "ready",
    capability: "public_pages_only", record_intake: false });
});
