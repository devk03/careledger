/** Bounded loopback-only load check. All profiles, people and records are fictional. */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createHttpApp } from "../dist/http/app.js";

const profileId = "fictional-profile";
const householdId = "fictional-household";
const throughDay = "2030-12-31";
const days = Array.from({ length: 365 }, (_, index) => {
  const date = new Date(Date.UTC(2030, 11, 31 - index)).toISOString().slice(0, 10);
  return {
    id: `fictional-day-${index}`,
    careProfileId: profileId,
    day: date,
    revision: 1,
    sources: [0, 1].map((part) => ({
      documentId: `fictional-document-${index}-${part}`,
      displayName: `fictional-document-${index}-${part}.pdf`,
      uploadedAt: "2031-01-01T00:00:00Z",
      sourceSha256: "a".repeat(64),
      pageNumbers: [1],
    })),
    statements: [],
  };
});

const app = createHttpApp({
  authenticate: async (request) => {
    if (request.headers.authorization === "Bearer fictional-member") {
      return { householdId, userId: "fictional-adult" };
    }
    if (request.headers.authorization === "Bearer other-fictional-family") {
      return { householdId: "other-fictional-household", userId: "other-fictional-adult" };
    }
    return null;
  },
  timeline: {
    profileBelongsToHousehold: async (id, household) =>
      id === profileId && household === householdId,
    listApprovedDays: async ({ householdId: requestedHousehold, careProfileId, throughDay: through, beforeDay, limit }) => {
      if (requestedHousehold !== householdId || careProfileId !== profileId) {
        throw new Error("Unscoped timeline read");
      }
      return days.filter((day) => day.day <= through &&
        (beforeDay === undefined || day.day < beforeDay)).slice(0, limit);
    },
  },
  pages: { readApprovedPageChunk: async () => null },
});

const server = await new Promise((resolve) => {
  const started = app.listen(0, "127.0.0.1", () => resolve(started));
});
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("Loopback listener unavailable");
}
const base = `http://127.0.0.1:${address.port}`;
const history = `${base}/api/v2/care-profiles/${profileId}/timeline/history?through=${throughDay}&limit=20`;
const dayList = `${base}/api/v2/care-profiles/${profileId}/timeline/days?through=${throughDay}&limit=20`;
const scenarios = [
  { name: "history", url: history, token: "fictional-member", expected: 200 },
  { name: "days", url: dayList, token: "fictional-member", expected: 200 },
  { name: "other-family", url: history, token: "other-fictional-family", expected: 404 },
  { name: "unauthenticated", url: history, token: null, expected: 401 },
];

function percentile(sorted, fraction) {
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
}

async function exercise(total, concurrency, choices = scenarios) {
  let next = 0;
  let failures = 0;
  const latencies = [];
  const statuses = {};
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < total) {
      const requestNumber = next++;
      const scenario = choices[requestNumber % choices.length];
      const requestStarted = performance.now();
      try {
        const response = await fetch(scenario.url, {
          headers: scenario.token === null ? {} : { authorization: `Bearer ${scenario.token}` },
          signal: AbortSignal.timeout(5000),
        });
        const payload = await response.json();
        const duration = performance.now() - requestStarted;
        latencies.push(duration);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status !== scenario.expected ||
          response.headers.get("cache-control") !== "no-store" ||
          (scenario.expected === 200 &&
            (payload.days?.length !== 20 || payload.days[0]?.day !== throughDay))) {
          failures += 1;
        }
      } catch {
        failures += 1;
      }
    }
  }));
  const elapsed = performance.now() - started;
  loop.disable();
  latencies.sort((left, right) => left - right);
  const result = {
    requests: total,
    concurrency,
    scenario: choices === scenarios ? "mixed" : "authorized-reads-only",
    completed: latencies.length,
    failures,
    statuses,
    elapsedSeconds: Math.round(elapsed / 100) / 10,
    requestsPerSecond: Math.round(total / elapsed * 1000),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    maxEventLoopDelayMs: Math.round(loop.max / 1e6),
    peakRssMiB: Math.round(process.memoryUsage().rss / 1048576),
  };
  console.log(JSON.stringify(result));
  if (failures > 0) process.exitCode = 1;
}

try {
  await exercise(200, 5);
  await exercise(2000, 20);
  await exercise(5000, 80);
  await exercise(5000, 80, scenarios.slice(0, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
