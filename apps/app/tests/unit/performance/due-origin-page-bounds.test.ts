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
  return inserted;
}

describe("due origin page bounds", () => {
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
      nextFetchAt: () => null,
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
      expect(origin.nextFetchAt === null || origin.nextFetchAt <= NOW).toBe(
        true,
      );
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

  it("keeps never-fetched and least recently fetched feeds active in two statements", async () => {
    const inserted = await seedFeeds({
      userId: "due-user",
      count: 6,
      isActive: () => true,
      nextFetchAt: () => null,
      // Feeds 0 and 3 never fetched; 1 and 4 oldest; 2 and 5 newest.
      lastFetchedAt: (index) =>
        index % 3 === 0
          ? null
          : new Date(NOW.getTime() - (index % 3 === 1 ? 3_600_000 : 60_000)),
    });

    session.instrumentation.reset();
    await deactivateExcessFeeds(session.database, "due-user", 2);
    const evidence = session.instrumentation.snapshot();
    expect(evidence.statementCount).toBe(2);

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
  });
});
