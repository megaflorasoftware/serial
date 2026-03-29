import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
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
      name: "self-hosted",
      use: { ...devices["Desktop Chrome"] },
      testDir: "./tests/e2e/self-hosted",
      testMatch: /.*\.spec\.ts/,
    },
  ],
  webServer: {
    command: "VITE_PUBLIC_IS_MAIN_INSTANCE=false pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
  },
});
