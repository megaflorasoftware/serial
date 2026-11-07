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

function hasSameKnownRevision(
  existingItem: ApplicationFeedItem,
  incomingItem: IncomingFeedItem,
) {
  return (
    !!existingItem.contentHash &&
    existingItem.contentHash === incomingItem.contentHash
  );
}

/**
 * Three cases by content revision. The server names a revision the client
 * has not seen: the incoming record replaces everything, so a stale body
 * cannot survive. Known and equal: the existing record stays and only user
 * state moves. Unknown on the server side: the incoming record wins field by
 * field, but a body already loaded is kept because list rows never carry
 * one. A body the server just sent is always the freshest, and the hash
 * rides along so the next revision is detectable.
 */
export function mergeFeedItem(
  existingItem: ApplicationFeedItem | undefined,
  incomingItem: IncomingFeedItem,
): ApplicationFeedItem {
  const normalizedIncomingItem = normalizeIncomingFeedItem(incomingItem);

  if (!existingItem || hasContentRevisionChanged(existingItem, incomingItem)) {
    return applyPendingFeedItemOverrides(normalizedIncomingItem);
  }

  const body = hasReaderBodyContent(normalizedIncomingItem.body)
    ? normalizedIncomingItem.body
    : existingItem.body;
  const contentHash =
    normalizedIncomingItem.contentHash ?? existingItem.contentHash;

  if (!hasSameKnownRevision(existingItem, incomingItem)) {
    return applyPendingFeedItemOverrides({
      ...normalizedIncomingItem,
      body,
      contentHash,
    });
  }

  return applyPendingFeedItemOverrides(
    mergeItemMetadata(
      {
        ...existingItem,
        body,
        contentHash,
        contentSnippet:
          existingItem.contentSnippet || normalizedIncomingItem.contentSnippet,
      },
      normalizedIncomingItem,
    ),
  );
}
