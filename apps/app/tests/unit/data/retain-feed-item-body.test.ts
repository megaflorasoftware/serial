import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationFeedItem } from "~/server/db/schema";
import { feedItemsStore, retainFeedItemBody } from "~/lib/data/store";

const mocks = vi.hoisted(() => ({
  requestFullTextForItems: vi.fn(),
}));

vi.mock("~/lib/orpc", () => ({
  orpcRouterClient: {
    initial: { requestFullTextForItems: mocks.requestFullTextForItems },
  },
}));

const now = new Date("2026-08-31T12:00:00.000Z");

const item = {
  id: "feed-item-one",
  feedId: 1,
  contentId: "content-one",
  title: "Article",
  author: "Author",
  url: "https://example.com/article",
  thumbnail: "",
  content: "",
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
} as ApplicationFeedItem;

beforeEach(() => {
  vi.clearAllMocks();
  feedItemsStore.getState().reset();
  feedItemsStore.getState().setFeedItems([item]);
});

describe("retainFeedItemBody", () => {
  it("retains the fetched body", async () => {
    mocks.requestFullTextForItems.mockResolvedValue([
      { id: item.id, content: "<p>Body</p>", contentSnippet: "Body" },
    ]);

    await retainFeedItemBody(item.id);

    expect(feedItemsStore.getState().feedItemsDict[item.id]?.content).toBe(
      "<p>Body</p>",
    );
    expect(feedItemsStore.getState().retainedFeedItemBodyIds[item.id]).toBe(
      true,
    );
  });

  it("stays silent when the body fetch fails", async () => {
    mocks.requestFullTextForItems.mockRejectedValue(new Error("offline"));

    await expect(retainFeedItemBody(item.id)).resolves.toBeUndefined();

    expect(feedItemsStore.getState().feedItemsDict[item.id]?.content).toBe("");
    expect(
      feedItemsStore.getState().retainedFeedItemBodyIds[item.id],
    ).toBeUndefined();
  });
});
