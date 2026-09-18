import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SKIP_ENV_VALIDATION", "false");
  vi.stubEnv("DATABASE_URL", "file:test.db");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret");
  vi.stubEnv("PUBLIC_BASE_URL", "http://localhost:3000");
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  undefined,
  "",
  "   ",
  "https://custom.example/service",
  "http://localhost:3009",
])("validates optional Slingshot configuration %s", async (value) => {
  vi.stubEnv("ATPROTO_SLINGSHOT_ENDPOINT", value);
  const { env } = await import("~/env");
  expect(env.ATPROTO_SLINGSHOT_ENDPOINT).toBe(value?.trim() || undefined);
});
it.each([
  "ftp://custom.example",
  "not-a-url",
  "https://user:secret@custom.example",
  "https://custom.example?key=secret",
  "https://custom.example#fragment",
])("rejects invalid service configuration %s", async (value) => {
  vi.stubEnv("ATPROTO_SLINGSHOT_ENDPOINT", value);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(import("~/env")).rejects.toThrow(
      "Invalid environment variables",
    );
  } finally {
    log.mockRestore();
  }
});
