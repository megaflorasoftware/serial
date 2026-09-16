// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://serial.test/" }

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationFeedItem } from "~/server/db/schema";
import { feedItemsStore, useFeedItemValue } from "~/lib/data/store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = new Date("2026-08-19T12:00:00.000Z");

function feedItem(): ApplicationFeedItem {
  return {
    sourceKind: "rss",
    atprotoUri: null,
    bodySource: "rss",
    tags: [],
    id: "article-one",
    feedId: 1,
    contentId: "article-one",
    title: "Article",
    author: "Author",
    url: "https://example.com/article",
    thumbnail: "",
    content: "",
    contentSnippet: "Preview",
    contentType: "text",
    isWatched: false,
    isWatchLater: false,
    progress: 0,
    duration: 0,
    orientation: null,
    postedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    isWatchedUpdatedAt: null,
    isWatchLaterUpdatedAt: null,
    contentHash: "content-hash",
    platform: "website",
  };
}

function MountedArticle() {
  const item = useFeedItemValue("article-one");
  return createElement("article", null, item?.content);
}

afterEach(() => {
  feedItemsStore.getState().reset();
});

describe("article content notification", () => {
  it("renders full text when it arrives after the reader mounts", () => {
    feedItemsStore.getState().setFeedItem("article-one", feedItem());
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(createElement(MountedArticle));
    });
    expect(container.textContent).toBe("");

    act(() => {
      feedItemsStore.getState().applyFulltextItems([
        {
          id: "article-one",
          content: "Complete article body",
          contentSnippet: "Complete preview",
        },
      ]);
    });

    expect(container.textContent).toBe("Complete article body");
    act(() => root.unmount());
  });
});
