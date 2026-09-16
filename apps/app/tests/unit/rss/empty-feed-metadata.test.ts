import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { feedOrigins, feeds, user } from "~/server/db/schema";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { fetchWebsiteFeedData } from "~/server/rss/parsers/website";
import { getCachedFeedResult } from "~/server/rss/feedCache";

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
  const [feed] = await fixture.database
    .insert(feeds)
    .values({
      userId: id,
      name: "Old",
      imageUrl: "",
      platform: "website",
      isActive: true,
    })
    .returning();
  const [origin] = await fixture.database
    .insert(feedOrigins)
    .values({
      userId: id,
      feedId: feed!.id,
      kind: "rss",
      locator: "https://example.com/feed",
    })
    .returning();
  return { feed: feed!, origin: origin! };
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
  expect(await fixture.database.select().from(feedOrigins)).toMatchObject([
    { etag: "new" },
    { etag: "new" },
  ]);
  expect(await getCachedFeedResult(first.origin.locator)).toMatchObject({
    status: "empty",
    data: { title: "New title", description: "New description" },
  });
  expect(fetchWebsiteFeedData).toHaveBeenCalledTimes(1);
});
