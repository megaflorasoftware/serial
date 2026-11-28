import { describe, expect, it } from "vitest";
import {
  canApplyStream,
  FREE_ACTIVITY_WINDOW_MS,
} from "~/server/jetstream/eligibility";
import { PLANS } from "~/server/subscriptions/plans";

const now = new Date("2026-09-18T12:00:00Z");
const account = { banned: false, banExpires: null, lastActiveAt: now };
describe("Jetstream eligibility", () => {
  it.each([
    [PLANS.free, true, now, true],
    [PLANS.free, false, now, false],
    [PLANS.free, true, null, false],
    [
      PLANS.free,
      true,
      new Date(now.getTime() - FREE_ACTIVITY_WINDOW_MS),
      false,
    ],
    [
      PLANS.free,
      true,
      new Date(now.getTime() - FREE_ACTIVITY_WINDOW_MS + 1),
      true,
    ],
    [PLANS.pro, true, null, true],
    [PLANS.pro, false, now, false],
    [PLANS["standard-small"], true, null, true],
    [PLANS["standard-small"], false, now, false],
  ] as const)(
    "uses the effective plan %s and background switch %s",
    (plan, backgroundEnabled, lastActiveAt, expected) => {
      expect(
        canApplyStream({
          account: { ...account, lastActiveAt },
          activeFeed: true,
          plan,
          backgroundEnabled,
          now,
        }),
      ).toBe(expected);
    },
  );
  it("allows explicit refresh when automatic work is disabled, while retaining Feed and account eligibility", () => {
    const input = {
      account,
      activeFeed: true,
      plan: PLANS.pro,
      backgroundEnabled: false,
      now,
      manual: true,
    };
    expect(canApplyStream(input)).toBe(true);
    expect(canApplyStream({ ...input, activeFeed: false })).toBe(false);
    expect(
      canApplyStream({ ...input, account: { ...account, banned: true } }),
    ).toBe(false);
  });
});
