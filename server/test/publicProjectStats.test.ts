import { expect, it } from "vitest";

import { PublicProjectStatsCache } from "../src/publicProjectStats.js";

it("fetches one fixed public repository count and keeps a bounded stale value", async () => {
  let now = 1_800_000_000_000;
  const calls: { url: unknown; init: RequestInit | undefined }[] = [];
  let reply: Response = Response.json({ stargazers_count: 42 });
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    return reply;
  };
  const cache = new PublicProjectStatsCache(fetcher, () => now);
  expect(await cache.read()).toEqual({ stars: 42,
    checked_at: 1_800_000_000, stale: false });
  expect(await cache.read()).toEqual({ stars: 42,
    checked_at: 1_800_000_000, stale: false });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://api.github.com/repos/devk03/careledger");
  expect(calls[0]?.init?.redirect).toBe("manual");
  expect(calls[0]?.init?.headers).not.toHaveProperty("Authorization");
  now += 3_600_001;
  reply = new Response("not available", { status: 503 });
  expect(await cache.read()).toEqual({ stars: 42,
    checked_at: 1_800_000_000, stale: true });
  expect(calls).toHaveLength(2);
  expect(await cache.read()).toEqual({ stars: 42,
    checked_at: 1_800_000_000, stale: true });
  expect(calls).toHaveLength(2);
  now += 300_001;
  reply = Response.json({ stargazers_count: 43 });
  expect((await cache.read()).stars).toBe(43);
  expect(calls).toHaveLength(3);
});

it("never invents a count when the public API returns malformed data", async () => {
  const cache = new PublicProjectStatsCache(async () =>
    Response.json({ stargazers_count: "millions" }));
  expect(await cache.read()).toEqual({ stars: null, checked_at: null,
    stale: false });
});
