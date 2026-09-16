import type { ViewSection } from "./useViewSections";
import type { ApplicationBookmark } from "~/server/mixed-content/projection";
import type { ApplicationView, DatabaseFeedCategory } from "~/server/db/schema";
import type { FeedItemListProjection } from "~/lib/data/feed-items/listProjection";
import type { ContentStatusFilter } from "~/lib/content-status";
import {
  createFeedItemFilterIndex,
  createFeedItemFilterPredicate,
} from "~/lib/data/feed-items/listProjection";
import { matchesScope } from "~/lib/data/mixed-content/bookmarkProjection";

export type SoftReadPosition = { sectionKey: string; index: number };

export function getEligibleSoftReadIds({
  positions,
  bookmarksById,
  feedItemsById,
  feedCategories,
  views,
  currentView,
  categoryFilter,
  feedFilter,
  saveStatus,
}: {
  positions: ReadonlyMap<string, SoftReadPosition>;
  bookmarksById: Record<string, ApplicationBookmark | undefined>;
  feedItemsById: Record<string, FeedItemListProjection | undefined>;
  feedCategories: DatabaseFeedCategory[];
  views: ApplicationView[];
  currentView: ApplicationView | null;
  categoryFilter: number;
  feedFilter: number;
  saveStatus: ContentStatusFilter["saveStatus"];
}) {
  if (saveStatus !== "saved" || positions.size === 0) return [];

  const filterIndex = createFeedItemFilterIndex(feedCategories, views);
  const makeFeedPredicate = (archiveStatus: "unread" | "archived") =>
    createFeedItemFilterPredicate({
      contentStatusFilter: { saveStatus, archiveStatus },
      categoryFilter,
      feedFilter,
      viewFilter: currentView,
      filterIndex,
    });
  const acceptsUnreadFeedItem = makeFeedPredicate("unread");
  const acceptsArchivedFeedItem = makeFeedPredicate("archived");
  const bookmarkScope =
    feedFilter >= 0
      ? ({ type: "feed", feedId: feedFilter } as const)
      : categoryFilter >= 0
        ? ({ type: "tag", tagId: categoryFilter } as const)
        : currentView
          ? ({ type: "view", viewId: currentView.id } as const)
          : null;

  return [...positions.keys()].filter((id) => {
    const bookmark = bookmarksById[id];
    if (bookmark) {
      return (
        bookmark.isSaved &&
        bookmarkScope !== null &&
        matchesScope(bookmark, bookmarkScope, views)
      );
    }
    const feedItem = feedItemsById[id];
    return Boolean(
      feedItem &&
      (feedItem.isWatched
        ? acceptsArchivedFeedItem(feedItem)
        : acceptsUnreadFeedItem(feedItem)),
    );
  });
}

export function softReadSectionKey(section: ViewSection) {
  return section.isUncategorized
    ? "uncategorized"
    : `${section.itemType}:${section.itemId}`;
}

export function retainEligibleSoftReadPositions(
  positions: ReadonlyMap<string, SoftReadPosition>,
  eligibleSections: ViewSection[],
) {
  const eligibleSectionKeyById = new Map<string, string>();
  for (const section of eligibleSections) {
    const sectionKey = softReadSectionKey(section);
    for (const id of section.items) eligibleSectionKeyById.set(id, sectionKey);
  }

  return new Map(
    [...positions].filter(
      ([id, position]) =>
        eligibleSectionKeyById.get(id) === position.sectionKey,
    ),
  );
}

/** Restore individually toggled items without freezing new pages or other removals. */
export function retainSoftReadPositions(
  sections: ViewSection[],
  positions: ReadonlyMap<string, SoftReadPosition>,
): ViewSection[] {
  if (positions.size === 0) return sections;

  const retainedBySection = new Map<string, Array<[string, number]>>();
  for (const [id, position] of positions) {
    const entries = retainedBySection.get(position.sectionKey) ?? [];
    entries.push([id, position.index]);
    retainedBySection.set(position.sectionKey, entries);
  }

  let startIndex = 0;
  return sections.map((section) => {
    const retained = retainedBySection.get(softReadSectionKey(section)) ?? [];
    retained.sort((left, right) => left[1] - right[1]);
    const liveItems = section.items.filter((id) => !positions.has(id));
    const items: string[] = [];
    let liveIndex = 0;
    for (const [id, index] of retained) {
      while (items.length < index && liveIndex < liveItems.length) {
        items.push(liveItems[liveIndex++]!);
      }
      items.push(id);
    }
    items.push(...liveItems.slice(liveIndex));
    const result = { ...section, items, startIndex };
    startIndex += items.length;
    return result;
  });
}
