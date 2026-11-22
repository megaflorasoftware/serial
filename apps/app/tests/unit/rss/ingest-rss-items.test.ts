import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { RSSContent } from "~/server/rss/types";
import type { readFeedHttp } from "~/server/rss/feedHttp";
import {
  feedItemAliases,
  feedItemObservations,
  feedItems,
  feeds,
  user,
} from "~/server/db/schema";
import {
  boundFeedItems,
  MAX_ITEM_CONTENT_BYTES,
  truncateUtf8,
} from "~/server/rss/feedBounds";
import { computeItemHash } from "~/server/rss/hash";
import { ingestRssItems } from "~/server/rss/ingestRssItems";
import { rssItemDigest, rssObservation } from "~/server/rss/itemObservation";
import { withLegacyInputs } from "~/server/rss/legacyItemHash";
import { parseSyndicationFeed } from "~/server/rss/syndication";
import { writeObservedItems } from "~/server/rss/writeItems";

vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const COVER = "https://example.com/cover.png";
const PAGE_IMAGE = "https://example.com/page.png";

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let feed: typeof feeds.$inferSelect;
let readPage: ReturnType<typeof vi.fn<typeof readFeedHttp>>;

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
  readPage = vi.fn<typeof readFeedHttp>((url) =>
    Promise.resolve({
      headers: new Headers(),
      ok: true,
      status: 200,
      statusText: "OK",
      text: `<meta property="og:image" content="${PAGE_IMAGE}">`,
      url,
    }),
  );
});

afterEach(() => fixture.cleanup());

/** An item whose feed supplies its thumbnail, so no page lookup is owed. */
function post(path: string, overrides: Partial<RSSContent> = {}): RSSContent {
  return {
    id: `guid-${path}`,
    url: `https://example.com/${path}`,
    title: path,
    author: "Author",
    publishedDate: "2026-09-15T12:00:00Z",
    content: `<p>${path}</p>`,
    thumbnail: COVER,
    mediaThumbnail: COVER,
    ...overrides,
  };
}

function ingest(items: RSSContent[]) {
  return ingestRssItems(fixture.database, feed, items, readPage);
}

const storedItems = () =>
  fixture.database.select().from(feedItems).orderBy(feedItems.url);

function rssObservations() {
  return fixture.database
    .select()
    .from(feedItemObservations)
    .where(eq(feedItemObservations.kind, "rss"));
}

it("writes nothing, opens no transaction and reads no page for an unchanged feed", async () => {
  await ingest([post("a"), post("b")]);
  const before = await storedItems();
  const transaction = vi.spyOn(fixture.database, "transaction");
  expect(await ingest([post("a"), post("b")])).toEqual({
    items: [],
    removedItemIds: [],
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(readPage).not.toHaveBeenCalled();
  expect(await storedItems()).toEqual(before);
});

it("writes only the items a feed states differently", async () => {
  await ingest([post("a"), post("b"), post("c")]);
  const [a, b, c] = await storedItems();
  const written = await ingest([
    post("a"),
    post("b", { content: "<p>edited</p>" }),
    post("c"),
  ]);
  expect(written.items.map((item) => item.id)).toEqual([b!.id]);
  expect(await storedItems()).toMatchObject([
    { id: a!.id, updatedAt: a!.updatedAt },
    { id: b!.id, content: "<p>edited</p>" },
    { id: c!.id, updatedAt: c!.updatedAt },
  ]);
});

it("rewrites every item when every item changed", async () => {
  const paths = ["a", "b", "c"];
  await ingest(paths.map((path) => post(path)));
  const written = await ingest(
    paths.map((path) => post(path, { title: `${path} again` })),
  );
  expect(written.items.map((item) => item.title).sort()).toEqual(
    paths.map((path) => `${path} again`),
  );
  expect((await rssObservations()).map((entry) => entry.digest).sort()).toEqual(
    paths
      .map((path) => rssItemDigest(post(path, { title: `${path} again` })))
      .sort(),
  );
});

it("updates an RSS observation whose change the document hides", async () => {
  await writeObservedItems(fixture.database, feed, [
    {
      ...rssObservation(post("a")),
      kind: "atproto",
      key: "at://did:plc:alice/site.standard.document/a",
      title: "Document title",
    },
  ]);
  await ingest([post("a")]);
  const [before] = await storedItems();
  const edited = post("a", { title: "Feed title" });
  expect((await ingest([edited])).items).toEqual([]);
  // The document's title still wins, so the visible item did not move.
  expect(await storedItems()).toEqual([before]);
  expect(await rssObservations()).toMatchObject([
    {
      digest: rssItemDigest(edited),
      value: { title: "Feed title" },
    },
  ]);
});

it("uses the last entry when a feed repeats a URL, and settles on it", async () => {
  const repeated = [
    post("a", { title: "first" }),
    post("a", { title: "last" }),
  ];
  await ingest(repeated);
  expect(await storedItems()).toMatchObject([{ title: "last" }]);
  const transaction = vi.spyOn(fixture.database, "transaction");
  await ingest(repeated);
  expect(transaction).not.toHaveBeenCalled();
});

it("falls back to one transaction when the stored item changes between its read and its write", async () => {
  await ingest([post("a")]);
  const transaction = fixture.database.transaction.bind(fixture.database);
  const opened = vi
    .spyOn(fixture.database, "transaction")
    .mockImplementationOnce(async (...args) => {
      // A reader marks the item watched after the ingest read it.
      await fixture.database
        .update(feedItems)
        .set({ isWatched: true, isWatchedUpdatedAt: new Date() });
      return transaction(...args);
    });
  // Reads on the database handle are the ones made outside a transaction.
  const reads = vi.spyOn(fixture.database, "select");
  const written = await ingest([post("a", { content: "<p>edited</p>" })]);
  // The verifying transaction wrote nothing; the second read and wrote under
  // the lock, with no read outside a transaction in between.
  expect(opened).toHaveBeenCalledTimes(2);
  const [verifying] = opened.mock.invocationCallOrder;
  expect(
    reads.mock.invocationCallOrder.filter((order) => order > verifying!),
  ).toEqual([]);
  reads.mockRestore();
  expect(written.items).toMatchObject([{ isWatched: true }]);
  expect(written.removedItemIds).toEqual([]);
  expect(await storedItems()).toMatchObject([
    { isWatched: true, content: "<p>edited</p>" },
  ]);
  expect(await rssObservations()).toMatchObject([
    { digest: rssItemDigest(post("a", { content: "<p>edited</p>" })) },
  ]);
});

it("leaves a document's alias alone when its RSS side changes", async () => {
  const key = "at://did:plc:alice/site.standard.document/a";
  await writeObservedItems(fixture.database, feed, [
    // A document without a body of its own shows the feed's.
    { ...rssObservation(post("a")), kind: "atproto", key, content: "" },
    rssObservation(post("a")),
  ]);
  await fixture.client.executeMultiple(`
    CREATE TABLE alias_write (locator text);
    CREATE TRIGGER alias_inserted AFTER INSERT ON serial_feed_item_alias
      BEGIN INSERT INTO alias_write VALUES (NEW.locator); END;
    CREATE TRIGGER alias_updated AFTER UPDATE ON serial_feed_item_alias
      BEGIN INSERT INTO alias_write VALUES (NEW.locator); END;
  `);
  const written = await ingest([post("a", { content: "<p>edited</p>" })]);
  expect(written.items).toHaveLength(1);
  expect(
    (await fixture.client.execute("SELECT locator FROM alias_write")).rows,
  ).toEqual([]);
  expect(
    await fixture.database
      .select()
      .from(feedItemAliases)
      .where(
        and(
          eq(feedItemAliases.feedId, feed.id),
          like(feedItemAliases.locator, "atproto:%"),
        ),
      ),
  ).toHaveLength(1);
});

it("looks up page images for new and changed items only, one batch per fetch", async () => {
  const posts = Array.from({ length: 10 }, (_, index) =>
    post(`post-${index}`, { thumbnail: undefined, mediaThumbnail: undefined }),
  );
  await ingest(posts);
  expect(readPage).toHaveBeenCalledTimes(8);
  const before = await storedItems();
  expect(before.filter((item) => item.thumbnail === PAGE_IMAGE)).toHaveLength(
    8,
  );
  // The same feed again: no item changed, so no page is read and nothing moves.
  const transaction = vi.spyOn(fixture.database, "transaction");
  await ingest(posts);
  expect(readPage).toHaveBeenCalledTimes(8);
  expect(transaction).not.toHaveBeenCalled();
  expect(await storedItems()).toEqual(before);
  // An edited item is looked up with its change.
  await ingest([...posts.slice(0, 9), { ...posts[9]!, title: "edited" }]);
  expect(readPage).toHaveBeenCalledTimes(9);
  expect(readPage.mock.calls.at(-1)?.[0]).toBe(posts[9]!.url);
  expect(
    (await storedItems()).find((item) => item.title === "edited")?.thumbnail,
  ).toBe(PAGE_IMAGE);
});

it("keeps a page image through an edit that the batch could not look up again", async () => {
  await ingest([
    post("a", { thumbnail: undefined, mediaThumbnail: undefined }),
  ]);
  readPage.mockClear();
  // Eight newer items take the whole batch; the edited one waits.
  await ingest([
    ...Array.from({ length: 8 }, (_, index) =>
      post(`new-${index}`, { thumbnail: undefined, mediaThumbnail: undefined }),
    ),
    post("a", {
      thumbnail: undefined,
      mediaThumbnail: undefined,
      title: "edited",
    }),
  ]);
  expect(readPage).toHaveBeenCalledTimes(8);
  const edited = (await storedItems()).find((item) => item.title === "edited");
  expect(edited?.thumbnail).toBe(PAGE_IMAGE);
});

const LEGACY_FEED = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>Blog</title><link>https://example.com</link><description>Blog</description>
<item><title>Post</title><link>https://example.com/post</link><guid>guid-post</guid>
<dc:creator>Ada</dc:creator><pubDate>Tue, 15 Sep 2026 12:00:00 GMT</pubDate>
<content:encoded><![CDATA[
<p>${body}</p>
]]></content:encoded></item>
</channel></rss>`;

/** The items as the website parser hands them on: read both ways, then bounded. */
async function parsedWithLegacy(body: string) {
  const text = LEGACY_FEED(body);
  return boundFeedItems(
    await withLegacyInputs(
      text,
      parseSyndicationFeed(text, "https://example.com/feed").items,
    ),
  );
}

/** A row as the ingest before Feed origins stored it: the previous parser's reading and its hash. */
async function storeLegacyItem(thumbnail: string, body = "Body") {
  const previous = {
    contentId: "guid-post",
    title: "Post",
    author: "Ada",
    // The previous parser kept the whitespace around the body, and the
    // previous ingest bounded what it stored and hashed.
    content: truncateUtf8(`\n<p>${body}</p>\n`, MAX_ITEM_CONTENT_BYTES)!,
    thumbnail,
    postedAt: new Date("Tue, 15 Sep 2026 12:00:00 GMT"),
  };
  await fixture.database.insert(feedItems).values({
    ...previous,
    feedId: feed.id,
    url: "https://example.com/post",
    contentType: "text",
    contentHash: computeItemHash(previous),
  });
}

it.each(["", "https://example.com/looked-up.png"])(
  "leaves an item from before observations alone while its feed says the same, stored thumbnail=%s",
  async (thumbnail) => {
    await storeLegacyItem(thumbnail);
    const [before] = await storedItems();
    const transaction = vi.spyOn(fixture.database, "transaction");
    expect((await ingest(await parsedWithLegacy("Body"))).items).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
    expect(await storedItems()).toEqual([before]);
    expect(await rssObservations()).toEqual([]);
  },
);

it.each([
  ["ASCII", "x".repeat(MAX_ITEM_CONTENT_BYTES)],
  // Three-byte characters, offset so the bound falls inside one.
  ["multi-byte", `a${"\u20ac".repeat(MAX_ITEM_CONTENT_BYTES / 3)}`],
])(
  "leaves an item from before observations alone when its %s body was bounded",
  async (_, body) => {
    await storeLegacyItem("", body);
    const [before] = await storedItems();
    expect(Buffer.byteLength(before!.content)).toBeLessThanOrEqual(
      MAX_ITEM_CONTENT_BYTES,
    );
    const transaction = vi.spyOn(fixture.database, "transaction");
    expect((await ingest(await parsedWithLegacy(body))).items).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
    expect(await rssObservations()).toEqual([]);
  },
);

it("converts an item from before observations once its publisher edits it", async () => {
  await storeLegacyItem("");
  const [before] = await storedItems();
  const written = await ingest(await parsedWithLegacy("Edited"));
  expect(written.items).toMatchObject([{ id: before!.id }]);
  expect(await storedItems()).toMatchObject([
    { id: before!.id, content: "<p>Edited</p>" },
  ]);
  expect(await rssObservations()).toHaveLength(1);
});
