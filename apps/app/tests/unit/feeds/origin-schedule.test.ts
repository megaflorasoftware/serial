import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { NewFeedDetails } from "~/server/rss/types";
import { feedOrigins, feeds, user } from "~/server/db/schema";
import { setFeedsActive } from "~/server/feeds/activation";
import {
  attachMissingFeedOrigins,
  insertFeedWithOrigins,
} from "~/server/feeds/origins";
import { makeOriginsDue } from "~/server/feeds/schedule";

const PUBLICATION = "at://did:plc:alice/site.standard.publication/site";
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;

function details(name: string): NewFeedDetails {
  return {
    name,
    platform: "website",
    imageUrl: "",
    origins: [{ kind: "rss", locator: `https://example.com/${name}.xml` }],
  };
}

async function addFeed(userId: string, name: string, isActive: boolean) {
  return insertFeedWithOrigins(fixture.database, {
    userId,
    isActive,
    details: details(name),
  });
}

/** Each origin's schedule in origin order, as epoch seconds or null. */
async function schedules(feedId?: number) {
  const rows = await fixture.database
    .select({ nextFetchAt: feedOrigins.nextFetchAt })
    .from(feedOrigins)
    .where(feedId === undefined ? undefined : eq(feedOrigins.feedId, feedId))
    .orderBy(asc(feedOrigins.id));
  return rows.map((row) => row.nextFetchAt);
}

async function schedule(feedId: number, nextFetchAt: Date | null) {
  await fixture.database
    .update(feedOrigins)
    .set({ nextFetchAt })
    .where(eq(feedOrigins.feedId, feedId));
}

beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  const now = new Date();
  await fixture.database.insert(user).values(
    ["reader", "other"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
});

afterEach(() => fixture.cleanup());

describe("creating origins", () => {
  it("schedules an active Feed's origins at once and leaves an inactive Feed's unscheduled", async () => {
    const before = Math.floor(Date.now() / 1000) * 1000;
    const active = await addFeed("reader", "active", true);
    const inactive = await addFeed("reader", "inactive", false);

    const [due] = await schedules(active.id);
    expect(due!.getTime()).toBeGreaterThanOrEqual(before);
    expect(due!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(active.origins[0]!.nextFetchAt).toEqual(due);
    expect(await schedules(inactive.id)).toEqual([null]);
  });

  it("starts an attached origin on its Feed's schedule", async () => {
    const active = await addFeed("reader", "active", true);
    const inactive = await addFeed("reader", "inactive", false);
    const publication = [{ kind: "atproto" as const, locator: PUBLICATION }];

    const attached = await attachMissingFeedOrigins(
      fixture.database,
      active,
      publication,
    );
    expect(attached.origins[1]!.nextFetchAt).toBeInstanceOf(Date);
    await attachMissingFeedOrigins(fixture.database, inactive, [
      { kind: "atproto", locator: `${PUBLICATION}2` },
    ]);
    expect(await schedules(inactive.id)).toEqual([null, null]);
  });
});

describe("setFeedsActive", () => {
  it("unschedules a deactivated Feed and schedules it again on activation", async () => {
    const feed = await addFeed("reader", "feed", true);
    const future = new Date(Date.now() + 3_600_000);
    await schedule(feed.id, future);

    expect(
      await setFeedsActive(fixture.database, {
        userId: "reader",
        feedIds: [feed.id],
        isActive: false,
      }),
    ).toBe(1);
    expect(await schedules(feed.id)).toEqual([null]);

    const now = new Date("2026-11-22T10:00:00.000Z");
    await setFeedsActive(fixture.database, {
      userId: "reader",
      feedIds: [feed.id],
      isActive: true,
      now,
    });
    expect(await schedules(feed.id)).toEqual([now]);
    expect((await fixture.database.select().from(feeds).get())!.isActive).toBe(
      true,
    );
  });

  it("keeps the schedule of a Feed that was already active", async () => {
    const feed = await addFeed("reader", "feed", true);
    const future = new Date("2099-01-01T00:00:00.000Z");
    await schedule(feed.id, future);

    await setFeedsActive(fixture.database, {
      userId: "reader",
      feedIds: [feed.id],
      isActive: true,
    });
    expect(await schedules(feed.id)).toEqual([future]);
  });

  it("changes only the given user's Feeds", async () => {
    const theirs = await addFeed("other", "theirs", true);
    const before = await schedules(theirs.id);

    expect(
      await setFeedsActive(fixture.database, {
        userId: "reader",
        feedIds: [theirs.id],
        isActive: false,
      }),
    ).toBe(0);
    expect(await schedules(theirs.id)).toEqual(before);
    expect((await fixture.database.select().from(feeds).get())!.isActive).toBe(
      true,
    );
  });
});

describe("makeOriginsDue", () => {
  it("pulls scheduled origins forward and leaves unscheduled ones alone", async () => {
    const waiting = await addFeed("reader", "waiting", true);
    const overdue = await addFeed("reader", "overdue", true);
    const inactive = await addFeed("reader", "inactive", false);
    const now = new Date("2026-11-22T10:00:00.000Z");
    const past = new Date(now.getTime() - 60_000);
    await schedule(waiting.id, new Date(now.getTime() + 6 * 3_600_000));
    await schedule(overdue.id, past);

    await makeOriginsDue(
      fixture.database,
      eq(feedOrigins.userId, "reader"),
      now,
    );
    expect(await schedules(waiting.id)).toEqual([now]);
    expect(await schedules(overdue.id)).toEqual([past]);
    expect(await schedules(inactive.id)).toEqual([null]);
  });
});
