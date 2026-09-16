import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { OriginEvidence } from "~/server/feeds/revalidationEvidence";
import type { NewFeedOriginDetails } from "~/server/rss/types";
import { revalidateFeed } from "~/server/feeds/revalidate";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { feedItems, feedOrigins, feeds, user } from "~/server/db/schema";
import { newRssFeedDetails } from "~/server/rss/types";

const rss: OriginEvidence = {
  origin: newRssFeedDetails({
    url: "https://example.com/rss",
    name: "RSS name",
    platform: "website",
    imageUrl: "https://example.com/rss.png",
  }).origins[0]!,
  siteUrl: "https://example.com",
  itemUrls: new Set(["https://example.com/one", "https://example.com/two"]),
};
const publication: OriginEvidence = {
  origin: {
    kind: "atproto",
    locator: "at://did:plc:example/site.standard.publication/one",
    publicationDid: "did:plc:example",
    publicationRkey: "one",
    pdsUrl: "https://pds.example.com",
    sourceName: "Publication name",
    sourceImageUrl: "https://example.com/publication.png",
  },
  siteUrl: "https://example.com",
  itemUrls: new Set(["https://example.com/one"]),
};
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const read = vi.fn(
  async (origin: Pick<NewFeedOriginDetails, "kind" | "locator">) =>
    origin.kind === "rss" ? rss : publication,
);
const discover = vi.fn(async () => [
  {
    url: "https://example.com",
    origins: [rss.origin, publication.origin].map(({ kind, locator }) => ({
      kind: kind as "rss" | "atproto",
      locator,
    })),
  },
]);
const run = (feedId: number, owner = "owner") =>
  revalidateFeed(fixture.database, owner, feedId, {
    readOriginEvidence: read,
    discoverFeedOriginsForRevalidation: discover,
  });
const seed = (origins = [rss.origin]) =>
  insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    isActive: false,
    details: { name: "Original", platform: "website", origins },
  });
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
  read
    .mockReset()
    .mockImplementation(async (origin) =>
      origin.kind === "rss" ? rss : publication,
    );
  discover.mockReset().mockResolvedValue([
    {
      url: "https://example.com",
      origins: [rss.origin, publication.origin].map(({ kind, locator }) => ({
        kind: kind as "rss" | "atproto",
        locator,
      })),
    },
  ]);
});
afterEach(() => fixture.cleanup());

describe("Feed revalidation", () => {
  it.each(["rss", "atproto"])(
    "adds the missing origin to an %s Feed without replacing it",
    async (kind) => {
      const existing = kind === "rss" ? rss : publication;
      const feed = await seed([existing.origin]);
      const result = await run(feed.id);
      expect(result.origins).toHaveLength(2);
      expect(result.origins.find((origin) => origin.kind === kind)?.id).toBe(
        feed.origins[0]!.id,
      );
      expect(result).toMatchObject({
        id: feed.id,
        name: "Publication name",
        imageUrl: publication.origin.sourceImageUrl,
        isActive: false,
        openLocation: feed.openLocation,
      });
      expect(await fixture.database.select().from(feeds)).toHaveLength(1);
    },
  );
  it("preserves a custom name and saved article state while updating the icon", async () => {
    const feed = await seed();
    await fixture.database
      .update(feeds)
      .set({ name: "Mine", nameEditedAt: new Date(), openLocation: "origin" })
      .where(eq(feeds.id, feed.id));
    await fixture.database.insert(feedItems).values({
      id: "saved",
      feedId: feed.id,
      contentId: "saved",
      author: "Author",
      postedAt: new Date(),
      url: "https://example.com/one",
      title: "Article",
      content: "Excerpt",
      isWatchLater: true,
      isWatched: true,
      progress: 42,
    });
    const items = await fixture.database.select().from(feedItems);
    expect(await run(feed.id)).toMatchObject({
      name: "Mine",
      imageUrl: publication.origin.sourceImageUrl,
      openLocation: "origin",
      isActive: false,
    });
    expect(await fixture.database.select().from(feedItems)).toEqual(items);
  });
  it("succeeds without adding an unrelated origin", async () => {
    const feed = await seed();
    read.mockImplementation(async (origin) =>
      origin.kind === "rss"
        ? rss
        : {
            ...publication,
            itemUrls: new Set(["https://example.com/unrelated"]),
          },
    );
    expect((await run(feed.id)).origins).toHaveLength(1);
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
  });
  it("refreshes metadata without searching or reading documents when both origins exist", async () => {
    const feed = await seed([rss.origin, publication.origin]);
    expect((await run(feed.id)).name).toBe("Publication name");
    expect(discover).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(expect.anything(), false);
  });
  it("rejects a wrong owner before making network requests", async () => {
    const feed = await seed();
    await expect(run(feed.id, "someone-else")).rejects.toThrow(
      "Feed not found",
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("fails atomically if a candidate belongs to another Feed", async () => {
    const feed = await seed();
    await seed([publication.origin]);
    await expect(run(feed.id)).rejects.toThrow("different Feeds");
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
    expect(
      (
        await fixture.database.select().from(feeds).where(eq(feeds.id, feed.id))
      )[0]?.name,
    ).toBe("Original");
  });
  it("does not treat a failed source read as unchanged success", async () => {
    const feed = await seed();
    read.mockRejectedValue(new Error("Unavailable"));
    await expect(run(feed.id)).rejects.toThrow("Unavailable");
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
  });
  it("preserves a rename made during discovery", async () => {
    const feed = await seed();
    read.mockImplementation(async (origin) => {
      if (origin.kind === "atproto")
        await fixture.database
          .update(feeds)
          .set({ name: "Concurrent rename", nameEditedAt: new Date() })
          .where(eq(feeds.id, feed.id));
      return origin.kind === "rss" ? rss : publication;
    });
    expect((await run(feed.id)).name).toBe("Concurrent rename");
  });
  it("cannot restore a Feed deleted during discovery", async () => {
    const feed = await seed();
    read.mockImplementation(async (origin) => {
      if (origin.kind === "atproto")
        await fixture.database.delete(feeds).where(eq(feeds.id, feed.id));
      return origin.kind === "rss" ? rss : publication;
    });
    await expect(run(feed.id)).rejects.toThrow("Feed not found");
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(0);
  });
  it("repeated and concurrent passes never duplicate an origin", async () => {
    const feed = await seed();
    await Promise.all([run(feed.id), run(feed.id)]);
    await run(feed.id);
    expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
  });
});

it("caps candidate verification even when discovery returns many unrelated origins", async () => {
  const feed = await seed();
  discover.mockResolvedValue([
    {
      url: "https://example.com",
      origins: Array.from({ length: 20 }, (_, i) => ({
        kind: "atproto" as const,
        locator: `${publication.origin.locator}${i}`,
      })),
    },
  ]);
  read.mockImplementation(async (origin) =>
    origin.kind === "rss"
      ? rss
      : {
          ...publication,
          itemUrls: new Set(["https://example.com/unrelated"]),
        },
  );
  expect((await run(feed.id)).origins).toHaveLength(1);
  expect(read).toHaveBeenCalledTimes(5);
});

it("rejects a discovered alternate RSS URL already belonging to another Feed", async () => {
  const feed = await seed([publication.origin]);
  await seed([{ ...rss.origin, locator: "https://example.com/atom" }]);
  read.mockImplementation(async (origin) =>
    origin.kind === "rss"
      ? {
          ...rss,
          origin: {
            ...rss.origin,
            alternateLocators: ["https://example.com/atom"],
          },
        }
      : publication,
  );
  await expect(run(feed.id)).rejects.toThrow("different Feeds");
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
});

it("protects uncertain legacy names even when migration copied them into source metadata", async () => {
  const feed = await seed([{ ...rss.origin, sourceName: "Original" }]);
  await fixture.client.execute(
    readFileSync(
      "src/server/db/migrations/0057_preserve_feed_names.sql",
      "utf8",
    ),
  );
  expect(await run(feed.id)).toMatchObject({
    name: "Original",
    imageUrl: publication.origin.sourceImageUrl,
  });
  const [protectedFeed] = await fixture.database
    .select()
    .from(feeds)
    .where(eq(feeds.id, feed.id));
  expect(protectedFeed?.nameEditedAt).toBeInstanceOf(Date);
  const future = await seed([
    { ...rss.origin, locator: "https://example.com/future" },
  ]);
  expect(future.nameEditedAt).toBeNull();
});
