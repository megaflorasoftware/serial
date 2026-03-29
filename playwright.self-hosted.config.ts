import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  globalSetup: "./tests/global-setup.self-hosted.ts",
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 180000,
  expect: { timeout: 5000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "self-hosted",
      use: { ...devices["Desktop Chrome"] },
      testDir: "./tests/e2e/self-hosted",
      testMatch: /.*\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: "pnpm dev:test:self-hosted",
      url: "http://localhost:3000",
      reuseExistingServer: false,
    },
    {
      command: "node --import=tsx tests/e2e/fixtures/rss-server.ts",
      url: "http://127.0.0.1:3003",
      reuseExistingServer: false,
    },
  ],
});
