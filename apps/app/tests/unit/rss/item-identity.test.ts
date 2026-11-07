import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { feedItemAliases, feedItems, feeds, user } from "~/server/db/schema";
import { rssObservation } from "~/server/rss/itemObservation";
import { writeObservedItems } from "~/server/rss/writeItems";

vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let feed: typeof feeds.$inferSelect;

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
  feed = (
    await fixture.database
      .insert(feeds)
      .values({
        userId: "reader",
        name: "Feed",
        platform: "website",
        imageUrl: "",
      })
      .returning()
  )[0]!;
});

afterEach(() => fixture.cleanup());

function observation(path: string) {
  return rssObservation({
    id: "reused-guid",
    url: `https://example.com/${path}`,
    title: path,
    author: "Author",
    publishedDate: "2026-09-15T12:00:00Z",
  });
}

it.each([true, false])(
  "keeps distinct RSS URLs with the same GUID, same batch=%s",
  async (sameBatch) => {
    if (sameBatch) {
      await writeObservedItems(fixture.database, feed, [
        observation("a"),
        observation("b"),
      ]);
    } else {
      await writeObservedItems(fixture.database, feed, [observation("a")]);
      await writeObservedItems(fixture.database, feed, [observation("b")]);
    }
    const items = await fixture.database.select().from(feedItems);
    expect(items.map((item) => item.url).sort()).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  },
);

it("ignores an ambiguous historical RSS alias and preserves document state", async () => {
  const document = {
    ...observation("old"),
    kind: "atproto" as const,
    key: "at://did:plc:alice/site.standard.document/post",
  };
  const original = (
    await writeObservedItems(fixture.database, feed, [
      document,
      observation("old"),
    ])
  ).items[0]!;
  await fixture.database
    .update(feedItems)
    .set({
      isWatchLater: true,
      isWatchLaterUpdatedAt: new Date(),
      progress: 75,
    })
    .where(eq(feedItems.id, original.id));
  // Earlier versions/backfills may have created a GUID alias for the document.
  await fixture.database
    .insert(feedItemAliases)
    .values({
      feedId: feed.id,
      locator: "rss:reused-guid",
      itemId: original.id,
    })
    .onConflictDoNothing();
  const other = (
    await writeObservedItems(fixture.database, feed, [observation("new")])
  ).items[0]!;
  const refreshed = await writeObservedItems(fixture.database, feed, [
    observation("new"),
  ]);
  expect(refreshed.removedItemIds).toEqual([]);
  expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
  expect(
    await fixture.database
      .select()
      .from(feedItems)
      .where(eq(feedItems.id, original.id))
      .get(),
  ).toMatchObject({
    atprotoUri: document.key,
    url: document.url,
    isWatchLater: true,
    progress: 75,
  });
  const merged = await writeObservedItems(fixture.database, feed, [
    { ...document, url: other.url },
  ]);
  expect(merged.removedItemIds).toEqual([other.id]);
  expect(await fixture.database.select().from(feedItems)).toMatchObject([
    { id: original.id, url: other.url, isWatchLater: true, progress: 75 },
  ]);
});
