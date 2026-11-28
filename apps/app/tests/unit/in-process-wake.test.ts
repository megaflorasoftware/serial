import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInProcessWake } from "~/server/inProcessWake";
import { logError } from "~/server/logger";

vi.mock("~/server/logger", () => ({ logError: vi.fn() }));

const target = {};
let finishRun: (more: boolean) => void;
let failRun: (error: Error) => void;
const run = vi.fn(
  () =>
    new Promise<boolean>((resolve, reject) => {
      finishRun = resolve;
      failRun = reject;
    }),
);

beforeEach(() => {
  vi.useFakeTimers();
  run.mockClear();
});
afterEach(() => vi.useRealTimers());

it("runs once at a time and runs again after a wake during the run", async () => {
  const wake = createInProcessWake("test", run);
  wake(target);
  wake(target);
  wake(target);
  expect(run).toHaveBeenCalledTimes(1);
  finishRun(false);
  await vi.advanceTimersByTimeAsync(1100);
  expect(run).toHaveBeenCalledTimes(2);
  finishRun(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it("runs again while work is left due", async () => {
  const wake = createInProcessWake("test", run);
  wake(target);
  finishRun(true);
  await vi.advanceTimersByTimeAsync(1100);
  expect(run).toHaveBeenCalledTimes(2);
  finishRun(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
});

it("logs a failed run and still honours a wake during it", async () => {
  const wake = createInProcessWake("test", run);
  wake(target);
  wake(target);
  failRun(new Error("database unavailable"));
  await vi.advanceTimersByTimeAsync(1100);
  expect(logError).toHaveBeenCalledWith(
    "[test] worker failed",
    expect.any(Error),
  );
  expect(run).toHaveBeenCalledTimes(2);
  finishRun(false);
});
