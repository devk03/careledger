import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const widths = [320, 375, 414, 768, 1280];
test.beforeEach(async ({ page }) => {
  await page.route("**/api/public/project", route => route.fulfill({ json: { stars: 12, stale: false } }));
});

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

for (const width of widths) {
  for (const authPage of [
    {
      path: "/setup#token=synthetic-private-token",
      heading: "Set up your private Adeno.",
      name: "setup",
    },
    {
      path: "/login",
      heading: "Return to the family workspace.",
      name: "login",
    },
    {
      path: "/recover",
      heading: "Use one saved recovery code.",
      name: "recovery",
    },
  ]) {
    test(`${authPage.name} is accessible without overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 500 ? 812 : 1024 });
      await page.goto(authPage.path);

      await expect(page.getByRole("heading", { name: authPage.heading })).toBeVisible();
      const sizes = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(sizes.document).toBe(sizes.viewport);
      // Linux Chromium may include the 2 px focus outline in body.scrollWidth even though
      // documentElement—the scrolling viewport—has no horizontal overflow.
      expect(sizes.body).toBeLessThanOrEqual(sizes.viewport + 2);

      const accessibility = await new AxeBuilder({ page }).analyze();
      const materialViolations = accessibility.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      );
      expect(materialViolations).toEqual([]);
    });
  }
}

for (const width of widths) {
  test(`record intake is accessible without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1024 });
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer" },
        }),
      });
    });
    await page.route("**/api/care-profiles", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { id: "profile-1", preferred_name: "Synthetic loved one", created_at: 1 },
        ]),
      });
    });
    await page.route("**/api/care-profiles/profile-1/documents", async (route) => {
      await route.fulfill({ contentType: "application/json", body: "[]" });
    });
    await page.goto("/records");

    await expect(
      page.getByRole("heading", { name: "Add records without losing where anything came from." }),
    ).toBeVisible();
    await expect(page.getByLabel("Choose a PDF or clear photo")).toBeAttached();
    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(sizes.document).toBe(sizes.viewport);
    expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);

    const accessibility = await new AxeBuilder({ page }).analyze();
    const materialViolations = accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(materialViolations).toEqual([]);
  });
}

for (const width of widths) {
  test(`care dashboard is accessible without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1024 });
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer" },
        }),
      });
    });
    await page.route("**/api/care-profiles", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify([
          { id: "profile-1", preferred_name: "Synthetic loved one", created_at: 1 },
        ]),
      });
    });
    await page.route("**/api/care-profiles/profile-1/workspace", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          profile_id: "profile-1",
          preferred_name: "Synthetic loved one",
          what_we_know: [],
          what_this_means: [],
          what_remains_unknown: [],
          timeline: [],
          questions: [
            {
              id: "question-1",
              text: "What does the synthetic result mean?",
              priority: "at_next_visit",
              state: "open",
              due_date: null,
            },
          ],
          followups: [],
          decisions: [],
        }),
      });
    });
    await page.goto("/workspace?profile=profile-1");

    await expect(
      page.getByRole("heading", { name: "Today for Synthetic loved one" }),
    ).toBeVisible();
    await expect(page.getByText("What does the synthetic result mean?")).toBeVisible();
    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(sizes.document).toBe(sizes.viewport);
    expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);

    const accessibility = await new AxeBuilder({ page }).analyze();
    const materialViolations = accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(materialViolations).toEqual([]);
  });
}

for (const width of widths) {
  test(`owner backup is accessible without overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width < 500 ? 812 : 1024 });
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          authenticated: true,
          csrf_token: "synthetic-csrf",
          user: { display_name: "Synthetic organizer", role: "owner" },
        }),
      });
    });
    await page.goto("/backup");

    await expect(
      page.getByRole("heading", { name: "Make a backup you can actually restore." }),
    ).toBeVisible();
    const sizes = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    expect(sizes.document).toBe(sizes.viewport);
    expect(sizes.body).toBeLessThanOrEqual(sizes.viewport);

    const accessibility = await new AxeBuilder({ page }).analyze();
    const materialViolations = accessibility.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    );
    expect(materialViolations).toEqual([]);
  });
}
