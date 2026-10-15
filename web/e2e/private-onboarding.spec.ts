import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ ...(process.env.ADENO_TEST_BROWSER_CHANNEL ? { channel: process.env.ADENO_TEST_BROWSER_CHANNEL } : {}) });

test("guides a new owner and copies an existing approval on desktop and narrow screens", async ({ page, context, baseURL }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let created = false;
  const grantId = "b".repeat(32);
  const profiles = [{ id: "invented-profile", preferredName: "Invented person" }];
  await page.route(new URL("/api/**", baseURL!).href, async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path.endsWith("/public/runtime")) body = { mode: "trusted_private", restricted_preview: false };
    else if (path.endsWith("/auth/session")) body = { csrfToken: "invented-csrf" };
    else if (path.endsWith("/care-profiles")) {
      if (route.request().method() === "POST") { created = true; body = { profile: profiles[0] }; }
      else body = { profiles: created ? profiles : [] };
    }
    else if (path.endsWith("/agent-connections/capabilities")) body = { available: true };
    else if (path.endsWith("/agent-connections/list")) body = { connections: [{ grantId, expiresAt: Math.floor(Date.now() / 1000) + 3600, state: "active" }] };
    else if (path.endsWith("/capabilities")) body = { available: false, mediaTypes: [], maxBytes: 0 };
    else if (path.endsWith("/notes/pending")) body = { pending: [] };
    else if (path.endsWith("/timeline/history")) body = { days: [], nextBeforeDay: null };
    else { await route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }); return; }
    await route.fulfill({ json: body, status: path.endsWith("/care-profiles") && route.request().method() === "POST" ? 201 : 200 });
  });
  await page.goto("/pilot");
  await expect(page.getByRole("heading", { name: "Who are you caring for?" })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "Copy setup instruction", exact: true }).click();
  await expect(page.getByText("Copied. Paste it into your Codex chat.")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(grantId); expect(copied).toContain("get_connection_profile and list_care_profiles");
  expect(copied).not.toContain("invented-csrf");
  await expect(page.getByText(/connection not yet verified/)).toBeVisible();
  await expect(page.getByLabel("Setup instruction")).not.toBeVisible();
  const widths = [1280, 768, 414, 375, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const copy = page.getByRole("button", { name: "Copy again" });
    expect(await copy.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`onboarding-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
  await page.getByLabel("Preferred name", { exact: true }).fill("Invented person");
  await page.getByRole("button", { name: "Create profile", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Add record images" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Invented person", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("navigation", { name: "Workspace shortcuts" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("workspace-1280.png"), fullPage: true });
});

test("keeps consent explicit and the checkbox usable before creating access", async ({ page, baseURL }, testInfo) => {
  let approvals = 0;
  await page.route(new URL("/api/**", baseURL!).href, async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown;
    if (path.endsWith("/auth/session")) body = { csrfToken: "invented-csrf" };
    else if (path.endsWith("/care-profiles")) body = { profiles: [] };
    else if (path.endsWith("/public/runtime")) body = { mode: "trusted_private", restricted_preview: false };
    else if (path.endsWith("/agent-connections/capabilities")) body = { available: true };
    else if (path.endsWith("/agent-connections/list")) body = { connections: [] };
    else if (path.endsWith("/agent-connections")) { approvals++; body = {}; }
    else body = { available: false };
    await route.fulfill({ json: body });
  });
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto("/pilot");
  const checkbox = page.getByRole("checkbox");
  await expect(checkbox).toBeEnabled();
  const bounds = await checkbox.boundingBox(); expect(bounds?.width).toBe(20); expect(bounds?.height).toBe(20);
  await expect(page.getByRole("button", { name: "Create setup instruction" })).toBeDisabled();
  await checkbox.check();
  await expect(page.getByRole("button", { name: "Create setup instruction" })).toBeEnabled();
  expect(approvals).toBe(0); // Checking a box alone never issues access.
  await page.screenshot({ path: testInfo.outputPath("consent-375.png"), fullPage: true });
});
