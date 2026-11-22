import { expect, it } from "vitest";
import { nextRetryAt, retryDelayMs } from "~/server/publication-sync/retry";

const minute = 60_000;
const day = 24 * 60 * minute;

it("doubles the wait from a minute and caps it at a day", () => {
  expect([1, 2, 3, 4, 5].map((attempts) => retryDelayMs(attempts))).toEqual([
    minute,
    2 * minute,
    4 * minute,
    8 * minute,
    16 * minute,
  ]);
  expect(retryDelayMs(11)).toBe(1024 * minute);
  expect(retryDelayMs(12)).toBe(day);
  expect(retryDelayMs(500)).toBe(day);
});

it("schedules each retry from now and stops once 14 days of waits are spent", () => {
  const now = new Date("2026-11-22T00:00:00Z");
  expect(nextRetryAt(1, now)).toEqual(new Date(now.getTime() + minute));
  expect(nextRetryAt(12, now)).toEqual(new Date(now.getTime() + day));
  // Eleven doubling waits total 2,047 minutes; thirteen daily waits pass 14 days.
  expect(nextRetryAt(24, now)).toEqual(new Date(now.getTime() + day));
  expect(nextRetryAt(25, now)).toBeNull();
  expect(nextRetryAt(10_000, now)).toBeNull();
});
