import type { ApplicationStore } from "./data/store";
import type {
  ApplicationViewSection,
  DatabaseFeedCategory,
} from "~/server/db/schema";
import { VIEW_LAYOUT_ITEM_TYPE } from "~/server/db/constants";

function getItemPlacement(
  feedId: number,
  viewSections: ApplicationViewSection[],
  feedCategories: DatabaseFeedCategory[],
): number {
  let minPlacement = Infinity;

  for (const section of viewSections) {
    if (section.itemType === VIEW_LAYOUT_ITEM_TYPE.FEED) {
      if (section.itemId === feedId) {
        minPlacement = Math.min(minPlacement, section.placement);
      }
    } else if (section.itemType === VIEW_LAYOUT_ITEM_TYPE.TAG) {
      for (const fc of feedCategories) {
        if (fc.feedId === feedId && fc.categoryId === section.itemId) {
          minPlacement = Math.min(minPlacement, section.placement);
        }
      }
    }
  }

  return minPlacement === Infinity ? 999999 : minPlacement;
}

export function sortFeedItemsOrderByDate(
  feedItems: ApplicationStore["feedItemsDict"],
) {
  return function (a: string, b: string) {
    const itemA = feedItems[a];
    const itemB = feedItems[b];

    if (!itemA || !itemB) return 0;

    const timeA =
      itemA.postedAt instanceof Date
        ? itemA.postedAt.getTime()
        : new Date(itemA.postedAt).getTime();
    const timeB =
      itemB.postedAt instanceof Date
        ? itemB.postedAt.getTime()
        : new Date(itemB.postedAt).getTime();

    if (timeB !== timeA) {
      return timeB - timeA;
    }

    if (itemA.title !== itemB.title) {
      return itemA.title.localeCompare(itemB.title);
    }

    return itemA.id.localeCompare(itemB.id);
  };
}

export function sortFeedItemsOrderBySectionThenDate(
  feedItems: ApplicationStore["feedItemsDict"],
  viewSections: ApplicationViewSection[],
  feedCategories: DatabaseFeedCategory[],
) {
  return function (a: string, b: string) {
    const itemA = feedItems[a];
    const itemB = feedItems[b];

    if (!itemA || !itemB) return 0;

    const placementA = getItemPlacement(
      itemA.feedId,
      viewSections,
      feedCategories,
    );
    const placementB = getItemPlacement(
      itemB.feedId,
      viewSections,
      feedCategories,
    );

    if (placementA !== placementB) {
      return placementA - placementB;
    }

    const timeA =
      itemA.postedAt instanceof Date
        ? itemA.postedAt.getTime()
        : new Date(itemA.postedAt).getTime();
    const timeB =
      itemB.postedAt instanceof Date
        ? itemB.postedAt.getTime()
        : new Date(itemB.postedAt).getTime();

    if (timeB !== timeA) {
      return timeB - timeA;
    }

    if (itemA.title !== itemB.title) {
      return itemA.title.localeCompare(itemB.title);
    }

    return itemA.id.localeCompare(itemB.id);
  };
}
