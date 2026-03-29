import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  globalSetup: "./tests/global-setup.ts",
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "main",
      use: { ...devices["Desktop Chrome"] },
      testDir: "./tests/e2e/main",
      testMatch: /.*\.spec\.ts/,
    },
  ],
  webServer: {
    command: "pnpm dev:test:main",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
