import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { createFeedsForUser } from "~/server/feeds/create";
import { resolveFeedSelection } from "~/server/feeds/resolveSelection";
import { getFeedsActivationBudget } from "~/server/subscriptions/helpers";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  atprotoConnections,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { newRssFeedDetails } from "~/server/rss/types";
import { wakeRequestedSync } from "~/server/publication-sync/wake";

// The real wake would start a sync run against the PDS.
vi.mock("~/server/publication-sync/wake", () => ({
  wakeRequestedSync: vi.fn(),
}));
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
      // A name its reader chose, which an origin that joins must not replace.
      details: { ...rss, name: "Custom", nameEditedAt: new Date() },
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

describe("telling subscription sync about a user's new Feed", () => {
  const cleanConnection = () =>
    fixture.database.insert(atprotoConnections).values({
      id: "connection",
      userId: "owner",
      did: "did:plc:abcdefghijklmnopqrstuvwx",
      session: "encrypted",
      exportSubscriptions: true,
      subscriptionRequestId: "last-request",
      subscriptionRepoRev: "clean",
    });
  const connection = async () =>
    (await fixture.database.select().from(atprotoConnections).get())!;

  it("requests a silent full run when the Feed has an Atmosphere origin", async () => {
    await cleanConnection();
    await add();
    expect(await connection()).toMatchObject({
      subscriptionRepoRev: null,
      subscriptionRequestId: "last-request",
    });
    expect((await connection()).subscriptionNextAttemptAt).toBeInstanceOf(Date);
    // The run starts once the Feed has committed, not at the next scheduled task.
    expect(wakeRequestedSync).toHaveBeenLastCalledWith(fixture.database, true);
  });
  it("does not wake sync for a user who has it off", async () => {
    await add();
    expect(wakeRequestedSync).toHaveBeenLastCalledWith(fixture.database, false);
  });
  it("requests a run when an Atmosphere origin is attached to an existing Feed", async () => {
    await insertFeedWithOrigins(fixture.database, {
      userId: "owner",
      details: rss,
      isActive: true,
    });
    await cleanConnection();
    await add();
    expect((await connection()).subscriptionRepoRev).toBeNull();
  });
  it("leaves sync alone for a Feed with only an RSS origin", async () => {
    await cleanConnection();
    vi.mocked(resolveFeedSelection).mockResolvedValue([rss]);
    await add();
    expect(await connection()).toMatchObject({
      subscriptionRepoRev: "clean",
      subscriptionNextAttemptAt: null,
    });
    expect(wakeRequestedSync).toHaveBeenLastCalledWith(fixture.database, false);
  });
});
