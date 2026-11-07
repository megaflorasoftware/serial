import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderBody, ReferenceSnapshot } from "@serial/standard-site";
import type { ApplicationFeedItem } from "~/server/db/schema";
import { refreshFeedItemReferences } from "~/lib/data/feed-items/referenceRefresh";
import { feedItemsStore } from "~/lib/data/store";

const mocks = vi.hoisted(() => ({ refreshReferences: vi.fn() }));

vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: {
    feedItem: { refreshReferences: mocks.refreshReferences },
  },
}));

const now = new Date("2026-08-31T12:00:00.000Z");

function snapshot(uri: string): ReferenceSnapshot {
  return {
    uri,
    cid: "bafref",
    outcome: "resolved",
    record: "{}",
    resolvedAt: now.toISOString(),
  };
}

function sourceBody(revision: string, references: ReferenceSnapshot[]) {
  return {
    form: "source",
    source: {
      uri: "at://did:plc:alice/site.standard.document/post",
      cid: revision,
      record: "{}",
      blobs: [],
    },
    references,
    revision,
  } satisfies ReaderBody;
}

function feedItem(body: ReaderBody | null): ApplicationFeedItem {
  return {
    id: "feed-item-one",
    feedId: 1,
    contentId: "content-one",
    title: "Article",
    author: "Author",
    url: "https://example.com/article",
    thumbnail: "",
    body,
    contentSnippet: "preview",
    contentType: "text",
    isWatched: false,
    isWatchLater: true,
    progress: 0,
    duration: 0,
    orientation: null,
    postedAt: now,
    createdAt: now,
    updatedAt: now,
    isWatchedUpdatedAt: null,
    isWatchLaterUpdatedAt: null,
    contentHash: "content-hash",
    platform: "website",
  } as unknown as ApplicationFeedItem;
}

function storedBody() {
  return feedItemsStore.getState().feedItemsDict["feed-item-one"]?.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  feedItemsStore.getState().reset();
});

describe("reference refresh", () => {
  it("applies refreshed snapshots to the same revision", async () => {
    const body = sourceBody("bafy", [snapshot("at://did:plc:bob/app/old")]);
    feedItemsStore.getState().setFeedItems([feedItem(body)]);
    const references = [snapshot("at://did:plc:bob/app/new")];
    mocks.refreshReferences.mockResolvedValue({ revision: "bafy", references });

    await refreshFeedItemReferences("feed-item-one");

    expect(storedBody()).toEqual({ ...body, references });
  });

  it("keeps the saved snapshots when the revision moved on", async () => {
    const body = sourceBody("bafy", [snapshot("at://did:plc:bob/app/old")]);
    feedItemsStore.getState().setFeedItems([feedItem(body)]);
    mocks.refreshReferences.mockResolvedValue({
      revision: "bafy-previous",
      references: [snapshot("at://did:plc:bob/app/new")],
    });

    await refreshFeedItemReferences("feed-item-one");

    expect(storedBody()).toEqual(body);
  });

  it("keeps the saved snapshots when the refresh fails", async () => {
    const body = sourceBody("bafy", [snapshot("at://did:plc:bob/app/old")]);
    feedItemsStore.getState().setFeedItems([feedItem(body)]);
    mocks.refreshReferences.mockRejectedValue(new Error("offline"));

    await expect(
      refreshFeedItemReferences("feed-item-one"),
    ).resolves.toBeUndefined();

    expect(storedBody()).toEqual(body);
  });

  it("never asks for an HTML body", async () => {
    feedItemsStore
      .getState()
      .setFeedItems([
        feedItem({ form: "html", html: "<p>Body</p>", revision: "hash" }),
      ]);

    await refreshFeedItemReferences("feed-item-one");

    expect(mocks.refreshReferences).not.toHaveBeenCalled();
  });
});
