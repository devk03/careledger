import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test.use({ ...(process.env.ADENO_TEST_BROWSER_CHANNEL ? { channel: process.env.ADENO_TEST_BROWSER_CHANNEL } : {}) });

test("opens an approved image citation with native decoding and readable narrow-screen provenance", async ({ page, baseURL }, testInfo) => {
  const data = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 500; canvas.height = 300;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Fixture canvas unavailable");
    context.fillStyle = "white"; context.fillRect(0, 0, 500, 300);
    context.fillStyle = "black"; context.font = "22px sans-serif";
    context.fillText("INDEPENDENTLY INVENTED FIXTURE", 20, 60);
    context.fillText("Not a medical record.", 20, 130);
    context.fillText("Care day: 2030-04-12", 20, 190);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const bytes = Buffer.from(data, "base64"); const digest = createHash("sha256").update(bytes).digest("hex");
  const requests: string[] = [];
  const source = { documentId: "image-a", displayName: "Invented source.pdf", mediaType: "image/png",
    uploadedAt: "2030-04-13T12:00:00Z", sourceSha256: digest, pageNumbers: [1] };
  // Match actual application API paths only, never Vite's /src/api module imports.
  await page.route(new URL("/api/**", baseURL!).href, async route => {
    const url = new URL(route.request().url()); const path = url.pathname; requests.push(path);
    if (path.endsWith("/original-image")) {
      expect(url.searchParams.get("expectedSha256")).toBe(digest);
      await route.fulfill({ contentType: "image/png", body: bytes, headers: { "cache-control": "private, no-store" } }); return;
    }
    let body: unknown;
    if (path.endsWith("/auth/session")) body = { csrfToken: "fictional-csrf" };
    else if (path.endsWith("/care-profiles")) body = { profiles: [{ id: "profile-a", preferredName: "Invented person" }] };
    else if (path.endsWith("/capabilities")) body = { available: false, mediaTypes: [], maxBytes: 0 };
    else if (path.endsWith("/notes/pending")) body = { pending: [] };
    else if (path.endsWith("/timeline/history")) body = { days: [{ id: "day-a", careProfileId: "profile-a", day: "2030-04-12",
      revision: 1, statements: [], sources: [source] }], nextBeforeDay: null };
    else if (path.endsWith("/public/runtime")) body = { restricted_preview: true };
    else { await route.fulfill({ status: 404, json: { error: "NOT_FOUND" } }); return; }
    await route.fulfill({ json: body });
  });
  await page.goto("/pilot");
  await page.getByRole("button", { name: "Open Invented source.pdf, page 1" }).click();
  const panel = page.getByRole("region", { name: "Source image", exact: true });
  const image = panel.getByRole("img"); await expect(image).toHaveJSProperty("naturalWidth", 500);
  await expect(image).toHaveJSProperty("naturalHeight", 300);
  await expect(panel.getByText(digest, { exact: true })).toBeVisible();
  const link = panel.getByRole("link", { name: "Open full-size original in a new tab" });
  await expect(link).toHaveAttribute("href", `/api/v2/care-profiles/profile-a/documents/image-a/original-image?expectedSha256=${digest}`);
  expect(requests.some(path => path.includes("/pages/"))).toBe(false);
  await panel.screenshot({ path: testInfo.outputPath("source-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath("source-mobile.png") });
  await panel.getByRole("button", { name: "Close source image" }).click();
  await expect(panel).toHaveCount(0);
});
