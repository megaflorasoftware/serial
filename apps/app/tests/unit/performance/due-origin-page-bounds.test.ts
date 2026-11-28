import { isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import {
  countDueFeeds,
  getDueFeedPage,
  RSS_FEED_PAGE_SIZE,
} from "~/server/rss/dueFeeds";
import { deactivateExcessFeeds } from "~/server/subscriptions/helpers";
import { feedOrigins, feeds, user } from "~/server/db/schema";

type Session = ReturnType<typeof openBenchmarkDatabase>;
type Target = ReturnType<typeof createLocalBenchmarkTarget>;

const NOW = new Date("2026-09-15T12:00:00.000Z");
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

let session: Session;
let target: Target;

beforeEach(async () => {
  target = createLocalBenchmarkTarget();
  session = openBenchmarkDatabase({ url: target.url });
  await applyMigrations(session.baseClient);
  await session.database.insert(user).values([
    {
      id: "due-user",
      name: "Due user",
      email: "due@example.com",
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "other-user",
      name: "Other user",
      email: "other-due@example.com",
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
});

afterEach(() => {
  session.close();
  target.cleanup();
});

async function seedFeeds(input: {
  userId: string;
  count: number;
  isActive: (index: number) => boolean;
  nextFetchAt: (index: number) => Date | null;
  lastFetchedAt?: (index: number) => Date | null;
}) {
  const rows = Array.from({ length: input.count }, (_, index) => ({
    userId: input.userId,
    name: `Feed ${index}`,
    imageUrl: "",
    platform: "website" as const,
    openLocation: "serial" as const,
    isActive: input.isActive(index),
    createdAt: NOW,
    updatedAt: NOW,
  }));
  const inserted: Array<{ id: number }> = [];
  for (let start = 0; start < rows.length; start += 200) {
    inserted.push(
      ...(await session.database
        .insert(feeds)
        .values(rows.slice(start, start + 200))
        .returning({ id: feeds.id })),
    );
  }
  const originRows = inserted.map((feed, index) => ({
    feedId: feed.id,
    userId: input.userId,
    kind: "rss",
    locator: `https://example.com/${input.userId}/${index}.xml`,
    nextFetchAt: input.nextFetchAt(index),
    lastFetchedAt: input.lastFetchedAt?.(index) ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  }));
  for (let start = 0; start < originRows.length; start += 200) {
    await session.database
      .insert(feedOrigins)
      .values(originRows.slice(start, start + 200));
  }
  await session.baseClient.execute(
    "INSERT INTO serial_feed_origin_rss (origin_id) SELECT id FROM serial_feed_origin WHERE kind = 'rss' AND id NOT IN (SELECT origin_id FROM serial_feed_origin_rss)",
  );
  return inserted;
}

/** The query plan of each statement the last operation ran, joined per statement. */
async function queryPlans() {
  const plans: string[] = [];
  for (const { sql } of session.instrumentation.snapshot().statements) {
    const plan = await session.baseClient.execute({
      sql: `EXPLAIN QUERY PLAN ${sql}`,
      args: Array.from(sql.matchAll(/\?/g), () => 0),
    });
    plans.push(plan.rows.map((row) => String(row.detail)).join("\n"));
  }
  return plans;
}

describe("due origin page bounds", () => {
  it("answers an idle due check from the schedule alone, whatever the user's Feed count", async () => {
    // Nothing is due: 40 active Feeds wait for their time, 2,000 inactive
    // Feeds are unscheduled, and 30 stream-covered origins wait out their
    // backstop. An origin with no time used to count as due, so this check
    // read every origin the user owns.
    await seedFeeds({
      userId: "due-user",
      count: 40,
      isActive: () => true,
      nextFetchAt: () => FUTURE,
    });
    await seedFeeds({
      userId: "due-user",
      count: 2_000,
      isActive: () => false,
      nextFetchAt: () => null,
    });
    const covered = await seedFeeds({
      userId: "due-user",
      count: 30,
      isActive: () => true,
      nextFetchAt: () => FUTURE,
    });
    await session.database.insert(feedOrigins).values(
      covered.map(({ id }) => ({
        feedId: id,
        userId: "due-user",
        kind: "atproto",
        locator: `at://did:plc:alice/site.standard.publication/${id}`,
        nextFetchAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
      })),
    );

    session.instrumentation.reset();
    expect(await countDueFeeds(session.database, "due-user", NOW)).toBe(0);
    expect(session.instrumentation.snapshot().statementCount).toBe(1);
    const [countPlan] = await queryPlans();
    // A range over scheduled origins only; no walk of the user's origins.
    expect(countPlan).toMatch(
      /USING COVERING INDEX feed_origin_due_idx \(user_id=\? AND next_fetch_at<\?\)/,
    );
    expect(countPlan).not.toMatch(/SCAN/);

    session.instrumentation.reset();
    expect(
      await getDueFeedPage(session.database, { userId: "due-user", now: NOW }),
    ).toHaveLength(0);
    const evidence = session.instrumentation.snapshot();
    expect(evidence.statementCount).toBe(1);
    expect(evidence.materializedRows).toBe(0);
    const [pagePlan] = await queryPlans();
    expect(pagePlan).toContain("feed_origin_due_idx");
    expect(pagePlan).not.toMatch(/SCAN serial_feed/);
  });

  it("never treats an unscheduled origin or an inactive Feed as due", async () => {
    const [unscheduled, inactive, due] = await seedFeeds({
      userId: "due-user",
      count: 3,
      // The second Feed is inactive yet still carries a past time: the guard
      // for a schedule that outlived its Feed's active flag.
      isActive: (index) => index !== 1,
      nextFetchAt: (index) => (index === 0 ? null : PAST),
    });
    expect(await countDueFeeds(session.database, "due-user", NOW)).toBe(1);
    const page = await getDueFeedPage(session.database, {
      userId: "due-user",
      now: NOW,
    });
    expect(page.map(({ feed }) => feed.id)).toEqual([due!.id]);
    expect(page.map(({ feed }) => feed.id)).not.toContain(unscheduled!.id);
    expect(page.map(({ feed }) => feed.id)).not.toContain(inactive!.id);
  });

  it("keeps both due origins together and counts each Feed once", async () => {
    const seeded = await seedFeeds({
      userId: "due-user",
      count: 51,
      isActive: () => true,
      nextFetchAt: () => PAST,
    });
    await session.database.insert(feedOrigins).values(
      seeded.map(({ id }) => ({
        feedId: id,
        userId: "due-user",
        kind: "atproto",
        locator: `at://did:plc:alice/site.standard.publication/${id}`,
        nextFetchAt: PAST,
      })),
    );
    await session.baseClient.execute(
      "INSERT INTO serial_feed_origin_atproto (origin_id, publication_did) SELECT id, 'did:plc:alice' FROM serial_feed_origin WHERE kind = 'atproto' AND id NOT IN (SELECT origin_id FROM serial_feed_origin_atproto)",
    );
    expect(await countDueFeeds(session.database, "due-user", NOW)).toBe(51);
    session.instrumentation.reset();
    const page = await getDueFeedPage(session.database, {
      userId: "due-user",
      now: NOW,
    });
    expect(page).toHaveLength(100);
    expect(new Set(page.map(({ feed }) => feed.id)).size).toBe(50);
    expect(session.instrumentation.snapshot().materializedRows).toBe(100);
    expect(session.instrumentation.snapshot().statementCount).toBe(1);
    const last = await getDueFeedPage(session.database, {
      userId: "due-user",
      now: NOW,
      afterFeedId: page.at(-1)!.feed.id,
    });
    expect(last).toHaveLength(2);
  });

  it("pages due origins on active feeds in one statement bounded by the page size", async () => {
    // 1,000 feeds: half inactive, and of the active half every third (the
    // multiples of six) is not yet due, so a page must skip many rows without
    // materialising them: 500 active minus 167 scheduled = 333 due.
    await seedFeeds({
      userId: "due-user",
      count: 1_000,
      isActive: (index) => index % 2 === 0,
      nextFetchAt: (index) => (index % 3 === 0 ? FUTURE : PAST),
    });
    await seedFeeds({
      userId: "other-user",
      count: 200,
      isActive: () => true,
      nextFetchAt: () => PAST,
    });

    session.instrumentation.reset();
    const dueCount = await countDueFeeds(session.database, "due-user", NOW);
    const countEvidence = session.instrumentation.snapshot();
    expect(dueCount).toBe(333);
    expect(countEvidence.statementCount).toBe(1);
    expect(countEvidence.materializedRows).toBe(1);

    session.instrumentation.reset();
    const firstPage = await getDueFeedPage(session.database, {
      userId: "due-user",
      now: NOW,
    });
    const pageEvidence = session.instrumentation.snapshot();
    expect(firstPage).toHaveLength(RSS_FEED_PAGE_SIZE);
    expect(pageEvidence.statementCount).toBe(1);
    expect(pageEvidence.materializedRows).toBe(RSS_FEED_PAGE_SIZE);
    for (const { origin, feed } of firstPage) {
      expect(origin.feedId).toBe(feed.id);
      expect(feed.isActive).toBe(true);
      expect(feed.userId).toBe("due-user");
      expect(origin.nextFetchAt).not.toBeNull();
      expect(origin.nextFetchAt! <= NOW).toBe(true);
    }

    // Walking every page by origin id cursor visits each due origin once.
    const seen = new Set<number>();
    let afterFeedId: number | undefined;
    let pages = 0;
    while (true) {
      const page = await getDueFeedPage(session.database, {
        userId: "due-user",
        afterFeedId,
        now: NOW,
      });
      if (page.length === 0) break;
      pages += 1;
      for (const { origin } of page) {
        expect(seen.has(origin.id)).toBe(false);
        seen.add(origin.id);
      }
      afterFeedId = page.at(-1)?.feed.id;
    }
    expect(seen.size).toBe(dueCount);
    expect(pages).toBe(Math.ceil(dueCount / RSS_FEED_PAGE_SIZE));
  });

  it("keeps never-fetched and least recently fetched feeds active in three statements", async () => {
    const inserted = await seedFeeds({
      userId: "due-user",
      count: 6,
      isActive: () => true,
      nextFetchAt: () => PAST,
      // Feeds 0 and 3 never fetched; 1 and 4 oldest; 2 and 5 newest.
      lastFetchedAt: (index) =>
        index % 3 === 0
          ? null
          : new Date(NOW.getTime() - (index % 3 === 1 ? 3_600_000 : 60_000)),
    });

    session.instrumentation.reset();
    await deactivateExcessFeeds(session.database, "due-user", 2);
    const evidence = session.instrumentation.snapshot();
    // One read, then the active flags and their origins' schedules together.
    expect(evidence.statementCount).toBe(3);

    const remaining = await session.database
      .select({ id: feeds.id, isActive: feeds.isActive })
      .from(feeds)
      .orderBy(feeds.id);
    const activeIds = remaining
      .filter((feed) => feed.isActive)
      .map((feed) => feed.id);
    // Same order the Feed-level column produced: ascending by earliest fetch
    // with never-fetched first, so the most recently fetched are deactivated.
    expect(activeIds).toEqual([inserted[0]!.id, inserted[3]!.id]);
    // Deactivated Feeds leave the schedule; the kept ones stay on it.
    const scheduled = await session.database
      .select({ feedId: feedOrigins.feedId })
      .from(feedOrigins)
      .where(isNotNull(feedOrigins.nextFetchAt))
      .orderBy(feedOrigins.feedId);
    expect(scheduled.map((origin) => origin.feedId)).toEqual(activeIds);
  });
});
