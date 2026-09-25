import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const width of [320, 375, 414, 768, 1280]) {
  test(`shared library works with fictional data at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const apiCalls: { method: string; url: string }[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/")) apiCalls.push({ method: request.method(), url: request.url() });
    });
    await page.goto("/design-system");
    await expect(page.getByRole("heading", { name: "One calm, familiar language." })).toBeVisible();
    await page.getByRole("button", { name: "Save sample", exact: true }).click();
    await expect(page.getByText("Sample saved in this tab only.")).toBeVisible();
    await page.getByRole("button", { name: "Check example" }).click();
    await expect(page.getByLabel("Fictional nickname")).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Fictional nickname").fill("Demo nickname");
    await page.getByRole("button", { name: "Check example" }).click();
    await expect(page.getByLabel("Fictional nickname")).not.toHaveAttribute("aria-invalid", "true");
    // The read-only runtime status check may show the safety notice. The
    // isolated component gallery must never call record, auth or AI APIs.
    const runtimeUrl = new URL("/api/public/runtime", page.url()).href;
    expect(apiCalls.some(call => call.method === "GET" && call.url === runtimeUrl)).toBe(true);
    expect(apiCalls.filter(call => call.method !== "GET" || call.url !== runtimeUrl)).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    const clipped = await page.locator("button, input:not([type=file]), select, textarea").evaluateAll(nodes => nodes
      .filter(node => { const rect=node.getBoundingClientRect(); return rect.width > 0 && (rect.left < 0 || rect.right > innerWidth); })
      .map(node => node.textContent || node.getAttribute("id")));
    expect(clipped).toEqual([]);
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    await page.screenshot({ path: `test-results/gallery-${width}.png`, fullPage: true });
  });
}

test("synthetic preview rejects mutation and unknown record access", async ({ request }) => {
  const mutation = await request.post("/api/auth/setup", { data: { fictional: true } });
  expect(mutation.status()).toBe(405);
  expect((await request.get("/api/documents/unknown/content")).status()).toBe(404);
  expect((await (await request.get("/api/ai/status")).json()).enabled).toBe(false);
});

test("keyboard focus and reduced-motion remain available", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/design-system");
  await page.getByRole("button", { name: "Save sample", exact: true }).focus();
  const state = await page.getByRole("button", { name: "Save sample", exact: true }).evaluate(node => {
    const style=getComputedStyle(node); return { outline: style.outlineStyle, width: style.outlineWidth, transition: style.transitionDuration };
  });
  expect(state.outline).toBe("solid");
  expect(parseFloat(state.width)).toBeGreaterThanOrEqual(2);
  expect(state.transition).toBe("0s");
  await page.goto("/records");
  await page.getByLabel("Choose a PDF or clear photo").focus();
  await expect(page.locator(".file-picker")).toHaveCSS("outline-style", "solid");
});

for (const width of [320, 1280]) {
  for (const route of ["setup", "records", "workspace"]) {
    test(`visual ${route} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${route}`);
      if (route === "workspace") await expect(page.getByRole("heading", { name: "Today for Demo family (fictional)" })).toBeVisible();
      else await expect(page.locator("h1")).toBeVisible();
      await page.screenshot({ path: `test-results/${route}-${width}.png`, fullPage: true });
    });
  }
}
