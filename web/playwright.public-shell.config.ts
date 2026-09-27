import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-public-shell",
  fullyParallel: true,
  forbidOnly: true,
  retries: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node runPublicShellForTests.mjs",
    url: "http://127.0.0.1:4174/health/ready",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
