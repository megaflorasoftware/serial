import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { throttleWithTrailing } from "~/server/publication-sync/throttle";

const action = vi.fn<() => Promise<void>>(async () => {});
const onError = vi.fn<(error: unknown) => void>();
const throttled = () => throttleWithTrailing(action, 1000, onError);

beforeEach(() => {
  vi.useFakeTimers();
  action.mockClear();
  onError.mockClear();
});
afterEach(() => vi.useRealTimers());

it("runs the first request at once and holds the next until the interval ends", async () => {
  const { request } = throttled();
  await request();
  expect(action).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300);
  await request();
  await request();
  expect(action).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(699);
  expect(action).toHaveBeenCalledTimes(1);
  // Several held requests share the one trailing run.
  await vi.advanceTimersByTimeAsync(1);
  expect(action).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(action).toHaveBeenCalledTimes(2);
});

it("runs at once again when the interval has passed since the last run", async () => {
  const { request } = throttled();
  await request();
  await vi.advanceTimersByTimeAsync(1000);
  await request();
  expect(action).toHaveBeenCalledTimes(2);
});

it("drops a trailing run that was cancelled", async () => {
  const { request, cancel } = throttled();
  await request();
  await request();
  cancel();
  await vi.advanceTimersByTimeAsync(5000);
  expect(action).toHaveBeenCalledTimes(1);
});

it("reports a trailing run that fails instead of leaving it unhandled", async () => {
  const { request } = throttled();
  await request();
  const failure = new Error("channel down");
  action.mockRejectedValueOnce(failure);
  await request();
  await vi.advanceTimersByTimeAsync(1000);
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
});
