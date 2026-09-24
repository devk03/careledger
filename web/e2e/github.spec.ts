import {expect, test} from "@playwright/test";

test("repository counter links to the right repo and fits mobile", async ({page}) => {
  await page.setViewportSize({width:320,height:900});
  await page.route("**/api/public/project", route => route.fulfill({json:{stars:12345,stale:false}}));
  await page.goto("/");
  const link=page.getByRole("link",{name:"adeno on GitHub, 12345 stars"});
  await expect(link).toHaveAttribute("href","https://github.com/devk03/careledger");
  await expect(link).toBeVisible();
  const prominent = page.getByRole("link", { name: "View adeno source on GitHub (opens in a new tab)", exact: true });
  await expect(prominent).toBeVisible();
  await expect(prominent).toHaveAttribute("href", "https://github.com/devk03/careledger");
  expect(await prominent.evaluate(node => node.getBoundingClientRect().right)).toBeLessThanOrEqual(320);
  await expect(prominent.locator("svg")).toHaveCount(1);
  await expect(prominent.locator("..")).toContainText("Open source");
  expect(await prominent.evaluate(node => node.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44);
  expect(await link.evaluate(node=>node.getBoundingClientRect().right)).toBeLessThanOrEqual(320);
});

test("counter outage does not hide the repository link", async ({page}) => {
  await page.route("**/api/public/project", route=>route.fulfill({status:503,body:"unavailable"}));
  await page.goto("/");
  await expect(page.getByRole("link",{name:"adeno on GitHub",exact:true})).toBeVisible();
  await expect(page.locator(".github-stars")).toHaveCount(0);
});
