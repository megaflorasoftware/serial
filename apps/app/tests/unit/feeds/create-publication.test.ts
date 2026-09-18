import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { createFeedsForUser } from "~/server/feeds/create";
import { resolveFeedSelection } from "~/server/feeds/resolveSelection";
import { getFeedsActivationBudget } from "~/server/subscriptions/helpers";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { feedOrigins, feeds, user } from "~/server/db/schema";
import { newRssFeedDetails } from "~/server/rss/types";

vi.mock("~/server/feeds/resolveSelection", () => ({
  resolveFeedSelection: vi.fn(),
}));
vi.mock("~/server/subscriptions/helpers", () => ({
  getFeedsActivationBudget: vi.fn(),
}));
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const rss = newRssFeedDetails({
  url: "https://example.com/rss",
  name: "Example",
  platform: "website",
});
const combined = {
  ...rss,
  origins: [
    ...rss.origins,
    {
      kind: "atproto",
      locator: "at://did:plc:example/site.standard.publication/one",
    },
  ],
};
beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  vi.mocked(resolveFeedSelection).mockResolvedValue([combined]);
  vi.mocked(getFeedsActivationBudget).mockResolvedValue({
    remainingSlots: 1,
    maxActiveFeeds: 1,
  });
});
afterEach(() => fixture.cleanup());
const add = () =>
  createFeedsForUser({
    database: fixture.database,
    userId: "owner",
    url: "https://example.com/rss",
    categoryIds: [],
  });

describe("creating combined Feeds", () => {
  it("creates two origins as one active Feed and consumes one slot", async () => {
    const result = await add();
    expect(result).toMatchObject({ createdCount: 1, deactivatedCount: 0 });
    expect(result.feeds).toHaveLength(1);
    expect(result.feeds[0]?.isActive).toBe(true);
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
  });
  it("attaches Atmosphere at the limit while preserving an inactive Feed", async () => {
    const original = await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: { ...rss, name: "Custom" },
      isActive: false,
    });
    vi.mocked(getFeedsActivationBudget).mockResolvedValue({
      remainingSlots: 0,
      maxActiveFeeds: 1,
    });
    const result = await add();
    expect(result).toMatchObject({ createdCount: 0, deactivatedCount: 0 });
    expect(result.feeds[0]).toMatchObject({
      id: original.id,
      name: "Custom",
      isActive: false,
    });
    expect(await fixture.database.select().from(feeds)).toHaveLength(1);
  });
  it("does not count a reused Feed against a later new Feed in the same request", async () => {
    await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: rss,
      isActive: false,
    });
    vi.mocked(resolveFeedSelection).mockResolvedValue([
      combined,
      newRssFeedDetails({
        url: "https://other.com/rss",
        name: "Other",
        platform: "website",
      }),
    ]);
    const result = await add();
    expect(result).toMatchObject({ createdCount: 1, deactivatedCount: 0 });
    expect(result.feeds[1]?.isActive).toBe(true);
  });
});
