import { defineConfig, devices } from "@playwright/test";
const testPort = Number(process.env.ADENO_TEST_PORT ?? "4173");
if (!Number.isInteger(testPort) || testPort < 1024 || testPort > 65535) throw new Error("Invalid test port");
const baseURL = `http://127.0.0.1:${testPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- --mode ui-preview --host 127.0.0.1 --port ${testPort} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
