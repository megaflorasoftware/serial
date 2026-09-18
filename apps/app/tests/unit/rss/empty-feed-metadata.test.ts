import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { feedOriginRss, feedOrigins, feeds, user } from "~/server/db/schema";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { fetchWebsiteFeedData } from "~/server/rss/parsers/website";
import { refreshUserFeeds } from "~/server/rss/refreshUserFeeds";
import {
  addRefreshStats,
  emptyRefreshStats,
  rssAttemptSummary,
} from "~/server/rss/stats";
import { publisher } from "~/server/api/publisher";
import { refreshOriginMetadata } from "~/server/rss/originMetadata";
import { getCachedFeedResult } from "~/server/rss/feedCache";

vi.mock("~/server/api/publisher", () => ({
  publisher: { publish: vi.fn(async () => undefined) },
}));

const kv = vi.hoisted(() => new Map<string, string>());
vi.mock("~/server/kv", () => ({
  getKV: async () => ({
    get: async (key: string) => kv.get(key),
    set: async (key: string, value: string) => {
      kv.set(key, value);
    },
  }),
}));
vi.mock("~/server/rss/parsers/website", () => ({
  fetchWebsiteFeedData: vi.fn(),
}));
vi.mock("~/server/logger", () => ({
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  kv.clear();
  vi.clearAllMocks();
});
afterEach(() => fixture.cleanup());

async function reader(id: string) {
  await fixture.database.insert(user).values({
    id,
    name: id,
    email: `${id}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const feed = await insertFeedWithOrigins(fixture.database, {
    userId: id,
    isActive: true,
    details: {
      name: "Old",
      imageUrl: "",
      platform: "website",
      origins: [{ kind: "rss", locator: "https://example.com/feed" }],
    },
  });
  return { feed, origin: feed.origins[0]! };
}

it("refreshes metadata and reports invalidation for live and cached empty feeds", async () => {
  const first = await reader("first");
  const second = await reader("second");
  vi.mocked(fetchWebsiteFeedData).mockResolvedValue({
    id: first.feed.id,
    title: "New title",
    imageUrl: "https://example.com/icon.png",
    description: "New description",
    url: "https://example.com",
    items: [],
    fetchMetadata: { etag: "new" },
  });
  for (const [index, fetchable] of [first, second].entries()) {
    const results = [];
    for await (const result of fetchAndInsertFeedData(
      { db: fixture.database },
      [fetchable],
    ))
      results.push(result);
    expect(results).toMatchObject([
      {
        status: "empty",
        metadataChanged: true,
        ...(index ? { fromCache: true } : {}),
      },
    ]);
  }
  expect(await fixture.database.select().from(feeds)).toMatchObject([
    { name: "New title", imageUrl: "https://example.com/icon.png" },
    { name: "New title", imageUrl: "https://example.com/icon.png" },
  ]);
  expect(await fixture.database.select().from(feedOriginRss)).toMatchObject([
    { etag: "new" },
    { etag: "new" },
  ]);
  expect(await getCachedFeedResult(first.origin.locator)).toMatchObject({
    status: "empty",
    data: { title: "New title", description: "New description" },
  });
  expect(fetchWebsiteFeedData).toHaveBeenCalledTimes(1);
});

it("carries metadata changes in the attempt summary without starting a separate repair", async () => {
  const fetchable = await reader("metadata");
  vi.mocked(fetchWebsiteFeedData).mockResolvedValue({
    id: fetchable.feed.id,
    title: "Updated title",
    url: "https://example.com",
    items: [],
    fetchMetadata: {},
  });
  const pageStats = await refreshUserFeeds({
    db: fixture.database,
    feedsList: [fetchable],
    channel: "reader",
  });
  const attemptStats = emptyRefreshStats();
  addRefreshStats(attemptStats, pageStats);
  expect(rssAttemptSummary(attemptStats)).toMatchObject({
    metadataChanged: true,
  });
  expect(
    vi
      .mocked(publisher.publish)
      .mock.calls.map(([, payload]) => payload.source),
  ).toEqual(["rss"]);
});

it("keeps the publication website through RSS refreshes and accepts later publication URL changes", async () => {
  const rss = await reader("combined");
  const [publication] = await fixture.database
    .insert(feedOrigins)
    .values({
      userId: "combined",
      feedId: rss.feed.id,
      kind: "atproto",
      locator: "at://did:plc:alice/site.standard.publication/blog",
    })
    .returning();
  const atmosphere = { feed: rss.feed, origin: publication! };
  await refreshOriginMetadata(fixture.database, atmosphere, {
    name: "Publication",
    siteUrl: "https://example.com/blog",
  });
  await refreshOriginMetadata(fixture.database, rss, {
    name: "RSS",
    siteUrl: "https://feeds.example.com/",
  });
  expect(await fixture.database.select().from(feeds)).toMatchObject([
    { name: "Publication", siteUrl: "https://example.com/blog" },
  ]);
  const currentOrigins = await fixture.database.select().from(feedOrigins);
  const currentFeed = (await fixture.database.select().from(feeds))[0]!;
  expect(
    await refreshOriginMetadata(
      fixture.database,
      {
        feed: currentFeed,
        origin: currentOrigins.find((origin) => origin.kind === "rss")!,
      },
      { name: "RSS", siteUrl: "https://feeds.example.com/" },
    ),
  ).toBe(false);
  await refreshOriginMetadata(fixture.database, atmosphere, {
    name: "Publication",
    siteUrl: "https://example.com/renamed",
  });
  expect(await fixture.database.select().from(feeds)).toMatchObject([
    { siteUrl: "https://example.com/renamed" },
  ]);
  const rssOnly = await reader("rss-only");
  await refreshOriginMetadata(fixture.database, rssOnly, {
    name: "RSS only",
    siteUrl: "https://rss.example.com/new-home",
  });
  expect(await fixture.database.select().from(feeds)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: rssOnly.feed.id,
        siteUrl: "https://rss.example.com/new-home",
      }),
    ]),
  );
});
