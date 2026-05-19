"use client";

import { useMemo } from "react";
import type { ApplicationView } from "~/server/db/schema";
import type { ViewLayout } from "~/server/db/constants";
import { useFeedCategories } from "~/lib/data/feed-categories";
import { feedItemsStore } from "~/lib/data/store";
import { useContentCategories } from "~/lib/data/content-categories";
import { useFeeds } from "~/lib/data/feeds";
import {
  VIEW_LAYOUT,
  VIEW_LAYOUT_ITEM_TYPE,
  viewLayoutSchema,
} from "~/server/db/constants";
import { INBOX_VIEW_ID } from "~/lib/data/views/constants";

export interface ViewSection {
  name: string;
  items: string[];
  layout: ViewLayout;
  startIndex: number;
  isUncategorized: boolean;
  itemType?: "feed" | "tag";
  itemId?: number;
}

export function useViewSections(
  currentView: ApplicationView | null,
  filteredFeedItemsOrder: string[],
) {
  const { feeds } = useFeeds();
  const { contentCategories } = useContentCategories();
  const feedItemsDict = feedItemsStore.useFeedItemsDict();
  const feedCategories = useFeedCategories();

  const isUncategorized = currentView?.id === INBOX_VIEW_ID;

  const baseLayout = useMemo(() => {
    const parsed = viewLayoutSchema.safeParse(currentView?.layout);
    return isUncategorized || !parsed.success ? VIEW_LAYOUT.LIST : parsed.data;
  }, [currentView?.layout, isUncategorized]);

  const hasSubviews =
    currentView &&
    !isUncategorized &&
    currentView.viewSections &&
    currentView.viewSections.length > 0;

  const computedSections = useMemo(() => {
    if (!hasSubviews || !currentView) return [] as ViewSection[];

    const feedIdToCategories = new Map<number, number[]>();
    for (const fc of feedCategories.feedCategories) {
      const existing = feedIdToCategories.get(fc.feedId);
      if (existing) {
        existing.push(fc.categoryId);
      } else {
        feedIdToCategories.set(fc.feedId, [fc.categoryId]);
      }
    }

    const allSectionItems = new Set<string>();
    const sections: ViewSection[] = [];
    let startIndex = 0;

    for (const li of currentView.viewSections) {
      const sectionItems = filteredFeedItemsOrder.filter((itemId) => {
        const item = feedItemsDict[itemId];
        if (!item) return false;

        if (li.itemType === VIEW_LAYOUT_ITEM_TYPE.FEED) {
          return item.feedId === li.itemId;
        }
        if (li.itemType === VIEW_LAYOUT_ITEM_TYPE.TAG) {
          const cats = feedIdToCategories.get(item.feedId) ?? [];
          return cats.includes(li.itemId);
        }
        return false;
      });

      const resolvedName =
        li.itemType === VIEW_LAYOUT_ITEM_TYPE.FEED
          ? (feeds.find((f) => f.id === li.itemId)?.name ?? "")
          : (() => {
              const tag = contentCategories.find((c) => c.id === li.itemId);
              return tag ? tag.name : "";
            })();

      const layout = (li.layout ?? baseLayout) as ViewLayout;

      sectionItems.forEach((id) => allSectionItems.add(id));

      sections.push({
        name: resolvedName,
        items: sectionItems,
        layout,
        startIndex,
        isUncategorized: false,
        itemType: li.itemType,
        itemId: li.itemId,
      });

      startIndex += sectionItems.length;
    }

    // Uncategorized: items not in any section
    const uncategorizedItems = filteredFeedItemsOrder.filter(
      (id) => !allSectionItems.has(id),
    );

    sections.push({
      name: "Uncategorized",
      items: uncategorizedItems,
      layout: baseLayout,
      startIndex,
      isUncategorized: true,
    });

    return sections;
  }, [
    hasSubviews,
    currentView,
    filteredFeedItemsOrder,
    feeds,
    contentCategories,
    baseLayout,
    feedItemsDict,
    feedCategories,
  ]);

  const flatItems = useMemo(() => {
    if (!hasSubviews) return filteredFeedItemsOrder;
    return computedSections.flatMap((s) => s.items);
  }, [hasSubviews, filteredFeedItemsOrder, computedSections]);

  const hasGridSections = useMemo(() => {
    if (!hasSubviews) {
      return (
        baseLayout === VIEW_LAYOUT.GRID || baseLayout === VIEW_LAYOUT.LARGE_GRID
      );
    }
    return computedSections.some(
      (s) =>
        s.layout === VIEW_LAYOUT.GRID || s.layout === VIEW_LAYOUT.LARGE_GRID,
    );
  }, [hasSubviews, baseLayout, computedSections]);

  const sectionInfo = useMemo(() => {
    if (!hasSubviews) return undefined;
    return computedSections.map((s) => ({
      size: s.items.length,
      isGrid:
        s.layout === VIEW_LAYOUT.GRID || s.layout === VIEW_LAYOUT.LARGE_GRID,
    }));
  }, [hasSubviews, computedSections]);

  return {
    hasSubviews,
    computedSections,
    flatItems,
    hasGridSections,
    sectionInfo,
    baseLayout,
  };
}
