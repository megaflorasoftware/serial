import { readFileSync } from "node:fs";
import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import type { ORPCContext } from "~/server/orpc/base";
import { user } from "~/server/db/schema";
import { savedOnboardingStep } from "~/lib/onboarding/progress";

const state = vi.hoisted((): { database: unknown } => ({
  database: undefined,
}));
vi.mock("~/server/db", () => ({
  get db() {
    return state.database;
  },
}));
vi.mock("~/server/auth", () => ({ auth: {} }));
const router = await import("~/server/api/routers/onboardingRouter");
let target: ReturnType<typeof createLocalBenchmarkTarget>;
let session: ReturnType<typeof openBenchmarkDatabase>;
beforeEach(async () => {
  target = createLocalBenchmarkTarget();
  session = openBenchmarkDatabase({ url: target.url });
  await applyMigrations(session.baseClient);
  state.database = session.database;
  await session.database.insert(user).values(
    ["one", "two"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
});
afterEach(() => {
  session.close();
  target.cleanup();
});
function api(id = "one") {
  return createRouterClient(router, {
    context: {
      headers: new Headers(),
      session: { id: "session" },
      user: { id },
      db: session.database,
    } as unknown as ORPCContext,
  });
}
it("uses bounded point reads and writes, keeps accounts isolated, and never reopens completion", async () => {
  session.instrumentation.reset();
  expect(await api().getProgress()).toEqual({ complete: false, step: null });
  expect(session.instrumentation.snapshot().materializedRows).toBe(1);
  session.instrumentation.reset();
  await api().saveProgress({
    complete: false,
    step: savedOnboardingStep("create-view"),
  });
  expect(session.instrumentation.snapshot().statementCount).toBe(1);
  expect(session.instrumentation.snapshot().materializedRows).toBe(0);
  expect((await api("two").getProgress()).step).toBeNull();
  await api().saveProgress({
    complete: true,
    step: savedOnboardingStep("next-steps"),
  });
  await api().saveProgress({
    complete: false,
    step: savedOnboardingStep("introduction"),
  });
  expect((await api().getProgress()).complete).toBe(true);
});
it("backfills existing accounts once while future accounts remain incomplete", async () => {
  await session.baseClient.execute(
    readFileSync(
      "src/server/db/post-migrations/0061_robust_texas_twister/01-complete-existing-users.sql",
      "utf8",
    ),
  );
  expect((await api().getProgress()).complete).toBe(true);
  await session.database.insert(user).values({
    id: "new",
    name: "new",
    email: "new@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  expect(await api("new").getProgress()).toEqual({
    complete: false,
    step: null,
  });
});
it("rejects unsupported progress versions", async () => {
  await expect(
    api().saveProgress({ complete: false, step: "2025-01-01-introduction" }),
  ).rejects.toThrow();
});
