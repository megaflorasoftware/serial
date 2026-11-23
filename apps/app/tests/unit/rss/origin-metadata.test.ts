import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { HydratedFeedOrigin } from "~/server/db/schema";
import { feedOrigins, feeds, user } from "~/server/db/schema";
import {
  attachMissingFeedOrigins,
  createOrReuseFeed,
  insertFeedWithOrigins,
} from "~/server/feeds/origins";
import { refreshOriginMetadata } from "~/server/rss/originMetadata";

vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const FEED_URL = "https://example.com/feed.xml";
const SAID = {
  name: "Blog",
  imageUrl: "https://example.com/icon.png",
  description: "A blog",
  siteUrl: "https://example.com",
};

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let feed: Awaited<ReturnType<typeof insertFeedWithOrigins>>;
let origin: HydratedFeedOrigin;

async function reload() {
  feed = { ...feed, ...(await storedFeed()) };
  origin = {
    ...origin,
    ...(await fixture.database
      .select()
      .from(feedOrigins)
      .where(eq(feedOrigins.id, origin.id))
      .get())!,
  };
}

async function storedFeed() {
  return (await fixture.database
    .select()
    .from(feeds)
    .where(eq(feeds.id, feed.id))
    .get())!;
}

beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  feed = await insertFeedWithOrigins(fixture.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Feed",
      platform: "website",
      imageUrl: "",
      origins: [{ kind: "rss", locator: FEED_URL }],
    },
  });
  origin = feed.origins[0]!;
  // The first fetch stores what the feed says about itself.
  expect(
    await refreshOriginMetadata(fixture.database, { origin, feed }, SAID),
  ).toBe(true);
  // A Feed that changed long ago, so a later touch shows.
  await fixture.database.update(feeds).set({ updatedAt: new Date(1_000) });
  await reload();
});
afterEach(() => fixture.cleanup());

it("writes nothing and opens no transaction when the feed says the same", async () => {
  const before = await storedFeed();
  const transaction = vi.spyOn(fixture.database, "transaction");
  const reads = vi.spyOn(fixture.database, "select");
  expect(
    await refreshOriginMetadata(fixture.database, { origin, feed }, SAID),
  ).toBe(false);
  expect(transaction).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
  reads.mockRestore();
  expect(await storedFeed()).toEqual(before);
});

it("stores a changed description on the origin without touching the Feed", async () => {
  const before = await storedFeed();
  expect(
    await refreshOriginMetadata(
      fixture.database,
      { origin, feed },
      { ...SAID, description: "A better blog" },
    ),
  ).toBe(true);
  expect(await storedFeed()).toEqual(before);
  await reload();
  expect(origin.sourceDescription).toBe("A better blog");
});

it("renames the Feed and moves its updated time when the feed's name changes", async () => {
  expect(
    await refreshOriginMetadata(
      fixture.database,
      { origin, feed },
      { ...SAID, name: "Renamed" },
    ),
  ).toBe(true);
  const stored = await storedFeed();
  expect(stored.name).toBe("Renamed");
  expect(stored.updatedAt.getTime()).toBeGreaterThan(feed.updatedAt.getTime());
});

it("leaves the site URL to the Publication with one read and no transaction", async () => {
  await attachMissingFeedOrigins(fixture.database, feed, [
    {
      kind: "atproto",
      locator: "at://did:plc:alice/site.standard.publication/site",
    },
  ]);
  const transaction = vi.spyOn(fixture.database, "transaction");
  const reads = vi.spyOn(fixture.database, "select");
  expect(
    await refreshOriginMetadata(
      fixture.database,
      { origin, feed },
      { ...SAID, siteUrl: "https://elsewhere.example.com" },
    ),
  ).toBe(false);
  expect(transaction).not.toHaveBeenCalled();
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockRestore();
  expect((await storedFeed()).siteUrl).toBe(SAID.siteUrl);
});

it("presents a Publication that joins an existing Feed without waiting for a fetch", async () => {
  const before = await storedFeed();
  const joined = await createOrReuseFeed(fixture.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Publication",
      platform: "website",
      imageUrl: "https://pub.example.com/icon.png",
      siteUrl: "https://pub.example.com",
      origins: [
        { kind: "rss", locator: FEED_URL },
        {
          kind: "atproto",
          locator: "at://did:plc:alice/site.standard.publication/site",
          sourceName: "Publication",
          sourceImageUrl: "https://pub.example.com/icon.png",
        },
      ],
    },
  });
  expect(joined).toMatchObject({ created: false, attached: true });
  const presented = {
    name: "Publication",
    imageUrl: "https://pub.example.com/icon.png",
    siteUrl: "https://pub.example.com",
  };
  // The Publication outranks the feed for the name, image and site URL.
  expect(joined.feed).toMatchObject(presented);
  const stored = await storedFeed();
  expect(stored).toMatchObject(presented);
  expect(stored.updatedAt.getTime()).toBeGreaterThan(
    before.updatedAt.getTime(),
  );
});

it("writes nothing more when the same origins are offered again", async () => {
  const details = {
    name: "Feed",
    platform: "website" as const,
    imageUrl: "",
    origins: [{ kind: "rss" as const, locator: FEED_URL }],
  };
  const before = await storedFeed();
  expect(
    await createOrReuseFeed(fixture.database, {
      userId: "reader",
      isActive: true,
      details,
    }),
  ).toMatchObject({ created: false, attached: false });
  expect(await storedFeed()).toEqual(before);
});
