import type { ApplicationFeedItem } from "~/server/db/schema";

export type IncomingFeedItem = Omit<ApplicationFeedItem, "content"> &
  Partial<Pick<ApplicationFeedItem, "content">>;

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
    content: incomingItem.content ?? "",
  } as ApplicationFeedItem;
}

function hasMatchingContentHash(
  existingItem: ApplicationFeedItem | undefined,
  incomingItem: IncomingFeedItem,
) {
  return (
    !!existingItem?.contentHash &&
    !!incomingItem.contentHash &&
    existingItem.contentHash === incomingItem.contentHash
  );
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

function getLatestMetadataItem(
  existingItem: ApplicationFeedItem,
  incomingItem: ApplicationFeedItem,
) {
  return existingItem.updatedAt.getTime() > incomingItem.updatedAt.getTime()
    ? existingItem
    : incomingItem;
}

export function mergeFeedItem(
  existingItem: ApplicationFeedItem | undefined,
  incomingItem: IncomingFeedItem,
): ApplicationFeedItem {
  const normalizedIncomingItem = normalizeIncomingFeedItem(incomingItem);

  if (!existingItem) {
    return normalizedIncomingItem;
  }

  const latestMetadataItem = getLatestMetadataItem(
    existingItem,
    normalizedIncomingItem,
  );

  if (!hasMatchingContentHash(existingItem, incomingItem)) {
    return mergeItemMetadata(normalizedIncomingItem, latestMetadataItem);
  }

  return mergeItemMetadata(
    {
      ...existingItem,
      content: existingItem.content || normalizedIncomingItem.content,
      contentSnippet:
        existingItem.contentSnippet || normalizedIncomingItem.contentSnippet,
    },
    latestMetadataItem,
  );
}
