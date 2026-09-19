import { afterEach, describe, expect, it } from "vitest";
import type { ReaderBody } from "@serial/standard-site";
import type { ApplicationFeedItem } from "~/server/db/schema";
import { mergeFeedItem } from "~/lib/data/feed-items/mergeFeedItem";
import {
  clearPendingFeedItemOverrides,
  setPendingWatchedOverride,
} from "~/lib/data/feed-items/pendingMutations";

function makeItem(
  overrides: Partial<ApplicationFeedItem> = {},
): ApplicationFeedItem {
  return {
    sourceKind: "rss",
    atprotoUri: null,
    bodySource: "rss",
    tags: [],
    id: "item-1",
    feedId: 1,
    contentId: "content-1",
    title: "Original title",
    author: "Original author",
    url: "https://example.com/original",
    thumbnail: "https://example.com/original.jpg",
    sourceCid: null,
    body: htmlBody("Original content"),
    contentSnippet: "Original snippet",
    contentType: "text",
    isWatched: false,
    isWatchLater: false,
    progress: 0,
    duration: 0,
    orientation: null,
    postedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    isWatchedUpdatedAt: null,
    isWatchLaterUpdatedAt: null,
    contentHash: "hash-1",
    platform: "website",
    ...overrides,
  };
}

function htmlBody(html: string, revision = "hash-1"): ReaderBody {
  return { form: "html", html, revision };
}

function sourceBody(): ReaderBody {
  return {
    form: "source",
    source: {
      uri: "at://did:plc:alice/site.standard.document/post",
      cid: "bafy",
      record: "{}",
      blobs: [],
    },
    references: [],
    revision: "bafy",
  };
}

describe("mergeFeedItem", () => {
  afterEach(() => {
    clearPendingFeedItemOverrides();
  });

  it("preserves versioned item fields when the content hash matches", () => {
    const existingItem = makeItem();
    const incomingItem = makeItem({
      title: "Incoming title",
      body: htmlBody("Incoming content"),
      contentSnippet: "Incoming snippet",
      thumbnail: "https://example.com/incoming.jpg",
      isWatched: true,
      isWatchLater: true,
      isWatchedUpdatedAt: new Date("2026-01-02"),
      isWatchLaterUpdatedAt: new Date("2026-01-03"),
      progress: 42,
      duration: 100,
      updatedAt: new Date("2026-01-04"),
      contentHash: "hash-1",
    });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.title).toBe("Original title");
    // Same revision, but the server sent a body: the served body is freshest.
    expect(mergedItem.body).toEqual(htmlBody("Incoming content"));
    expect(mergedItem.contentSnippet).toBe("Original snippet");
    expect(mergedItem.thumbnail).toBe("https://example.com/original.jpg");
    expect(mergedItem.isWatched).toBe(true);
    expect(mergedItem.isWatchLater).toBe(true);
    expect(mergedItem.isWatchedUpdatedAt).toEqual(new Date("2026-01-02"));
    expect(mergedItem.isWatchLaterUpdatedAt).toEqual(new Date("2026-01-03"));
    expect(mergedItem.progress).toBe(42);
    expect(mergedItem.duration).toBe(100);
    expect(mergedItem.updatedAt).toEqual(new Date("2026-01-04"));
  });

  it("uses incoming versioned fields when the content hash changes", () => {
    const existingItem = makeItem();
    const incomingItem = makeItem({
      title: "Incoming title",
      body: htmlBody("Incoming content"),
      contentSnippet: "Incoming snippet",
      thumbnail: "https://example.com/incoming.jpg",
      contentHash: "hash-2",
    });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.title).toBe("Incoming title");
    expect(mergedItem.body).toEqual(htmlBody("Incoming content"));
    expect(mergedItem.contentSnippet).toBe("Incoming snippet");
    expect(mergedItem.thumbnail).toBe("https://example.com/incoming.jpg");
  });

  it("accepts incoming server metadata regardless of updatedAt", () => {
    const existingItem = makeItem({
      isWatched: true,
      updatedAt: new Date("2026-01-04T12:00:00Z"),
    });
    const incomingItem = makeItem({
      updatedAt: new Date("2026-01-04T11:59:59Z"),
    });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.isWatched).toBe(false);
    expect(mergedItem.updatedAt).toEqual(new Date("2026-01-04T11:59:59Z"));
  });

  it("preserves explicitly pending fields when server metadata arrives", () => {
    const existingItem = makeItem({
      isWatched: true,
    });
    const pendingWatchedAt = new Date("2026-01-04T12:00:00Z");
    setPendingWatchedOverride(existingItem.id, true, pendingWatchedAt);
    const incomingItem = makeItem({
      updatedAt: new Date("2026-01-04T11:59:59Z"),
    });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.isWatched).toBe(true);
    expect(mergedItem.isWatchedUpdatedAt).toEqual(pendingWatchedAt);
    expect(mergedItem.updatedAt).toEqual(new Date("2026-01-04T11:59:59Z"));
  });

  it("fills a missing cached body when the hash matches", () => {
    const existingItem = makeItem({ body: null, contentSnippet: "" });
    const incomingItem = makeItem({ contentHash: "hash-1" });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.body).toEqual(htmlBody("Original content"));
    expect(mergedItem.contentSnippet).toBe("Original snippet");
  });

  it.each([
    ["an HTML", htmlBody("Original content")],
    ["a Document source", sourceBody()],
  ])(
    "keeps %s body across a hash-matching metadata refresh",
    (_label, body) => {
      const existingItem = makeItem({ body });
      const incomingItem = makeItem({ body: undefined, contentHash: "hash-1" });

      expect(mergeFeedItem(existingItem, incomingItem).body).toEqual(body);
    },
  );

  it("keeps a loaded body but takes the incoming record when no revision is known", () => {
    // Rows ingested before hashing and list payloads both lack a hash; the
    // body loaded by a direct open must survive the next list refresh, while
    // descriptor changes such as orientation still land.
    const existingItem = makeItem({ contentHash: null });
    const incomingItem = makeItem({
      body: undefined,
      contentHash: null,
      title: "Incoming title",
      orientation: "vertical",
    });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.body).toEqual(htmlBody("Original content"));
    expect(mergedItem.title).toBe("Incoming title");
    expect(mergedItem.orientation).toBe("vertical");
  });

  it("takes a freshly served body and its hash over a cached one", () => {
    const existingItem = makeItem({ contentHash: null });
    const incomingItem = makeItem({
      body: htmlBody("Edited content"),
      contentHash: "hash-2",
    });

    const mergedItem = mergeFeedItem(existingItem, incomingItem);

    expect(mergedItem.body).toEqual(htmlBody("Edited content"));
    expect(mergedItem.contentHash).toBe("hash-2");
    // The next list refresh can now tell a further revision apart.
    expect(
      mergeFeedItem(
        mergedItem,
        makeItem({ body: undefined, contentHash: "hash-3" }),
      ).body,
    ).toBeNull();
  });

  it("drops the cached body when the hash changes", () => {
    const existingItem = makeItem({ body: sourceBody() });
    const incomingItem = makeItem({ body: undefined, contentHash: "hash-2" });

    expect(mergeFeedItem(existingItem, incomingItem).body).toBeNull();
  });
});
