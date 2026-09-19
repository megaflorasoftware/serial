import { applyPendingFeedItemOverrides } from "./pendingMutations";
import { hasContentRevisionChanged, hasReaderBodyContent } from "./readerBody";
import type { ApplicationFeedItem } from "~/server/db/schema";

/** List and page payloads never carry bodies; only body endpoints do. */
export type IncomingFeedItem = Omit<ApplicationFeedItem, "body"> &
  Partial<Pick<ApplicationFeedItem, "body">>;

const FEED_ITEM_MERGE_FIELDS = {
  metadata: [
    "isWatched",
    "isWatchedUpdatedAt",
    "isWatchLater",
    "isWatchLaterUpdatedAt",
    "progress",
    "duration",
    "updatedAt",
  ],
} as const satisfies {
  metadata: ReadonlyArray<keyof ApplicationFeedItem>;
};

function normalizeIncomingFeedItem(
  incomingItem: IncomingFeedItem,
): ApplicationFeedItem {
  return {
    ...incomingItem,
    body: incomingItem.body ?? null,
  };
}

function mergeItemMetadata(
  baseItem: ApplicationFeedItem,
  metadataItem: ApplicationFeedItem,
) {
  const mergedItem = { ...baseItem };

  for (const field of FEED_ITEM_MERGE_FIELDS.metadata) {
    mergedItem[field] = metadataItem[field] as never;
  }

  return mergedItem;
}

export function mergeFeedItem(
  existingItem: ApplicationFeedItem | undefined,
  incomingItem: IncomingFeedItem,
): ApplicationFeedItem {
  const normalizedIncomingItem = normalizeIncomingFeedItem(incomingItem);

  if (!existingItem || hasContentRevisionChanged(existingItem, incomingItem)) {
    return applyPendingFeedItemOverrides(normalizedIncomingItem);
  }

  return applyPendingFeedItemOverrides(
    mergeItemMetadata(
      {
        ...existingItem,
        body: hasReaderBodyContent(existingItem.body)
          ? existingItem.body
          : normalizedIncomingItem.body,
        contentSnippet:
          existingItem.contentSnippet || normalizedIncomingItem.contentSnippet,
      },
      normalizedIncomingItem,
    ),
  );
}
