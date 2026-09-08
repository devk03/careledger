import { expect, test } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/public/project", route => route.fulfill({ json: { stars: 12, stale: false } }));
});

test("retry keeps dark text and warm fill through hover and press", async ({ page }) => {
  await page.goto("/design-system");
  const retry = page.getByRole("button", { name: "Try saving again" });
  const colors = () => retry.evaluate(node => {
    const style=getComputedStyle(node);
    return { text: style.color, background: style.backgroundColor, ink: getComputedStyle(document.documentElement).getPropertyValue("--color-ink").trim() };
  });
  const resting=await colors();
  expect(resting.text).toBe(resting.ink);
  await retry.hover();
  const hovered=await colors();
  expect(hovered.text).toBe(resting.text);
  await page.mouse.down();
  const pressed=await colors();
  expect(pressed.text).toBe(resting.text);
  expect(pressed.background).toBe(hovered.background);
  await page.mouse.up();
  // Switch to keyboard modality: pointer focus intentionally does not show a ring.
  await page.keyboard.press("Tab");
  const save=page.getByRole("button", {name: "Save sample", exact: true});
  await save.focus();
  expect(await save.evaluate(node => getComputedStyle(node).outlineColor)).toBe(resting.ink);
  await expect(save).toHaveCSS("outline-style", "solid");
});

for(const width of [320, 375, 414, 768, 1280]) {
  test(`original artwork loads and stays inside the page at ${width}px`, async ({page}) => {
    await page.setViewportSize({width, height:900});
    await page.goto("/");
    const hero=page.locator(".welcome-art img");
    await expect(hero).toBeVisible();
    await expect(hero).toHaveAttribute("fetchpriority", "high");
    await expect(hero).toHaveAttribute("alt", "");
    await expect.poll(() => hero.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const notes=page.locator(".journey-art img");
    await notes.scrollIntoViewIfNeeded();
    await expect.poll(() => notes.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const overflowing=await page.locator(".editorial-art").evaluateAll(nodes => nodes.some(node => {
      const rect=node.getBoundingClientRect();return rect.left < 0 || rect.right > innerWidth;
    }));
    expect(overflowing).toBe(false);
    await page.evaluate(() => scrollTo(0,0));
    await page.screenshot({path:`test-results/welcome-art-${width}.png`,fullPage:true});
  });
}

test("responsive artwork variants stay within the page media budget", async ({request}) => {
  let bytes=0;
  for(const name of ["garden-1200", "garden-640", "notes-1200", "notes-640"]) {
    const response=await request.get(`/images/${name}.webp`);
    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toContain("image/webp");
    bytes+=(await response.body()).length;
  }
  expect(bytes).toBeLessThan(800_000);
});
