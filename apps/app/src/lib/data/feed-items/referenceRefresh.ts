import { feedItemsStore } from "../store";
import type { ReferenceSnapshot } from "@serial/standard-site";
import { orpcRouterClient } from "~/lib/orpc";

export type RefreshedReferences = {
  revision: string;
  references: ReferenceSnapshot[];
};

/**
 * Refreshed snapshots belong to the revision they were asked for. A body that
 * changed underneath keeps its own snapshots, so the refresh can never move a
 * reader onto references from a different document revision.
 */
export function applyRefreshedReferences(
  itemId: string,
  refreshed: RefreshedReferences,
) {
  const store = feedItemsStore.getState();
  const item = store.feedItemsDict[itemId];
  if (
    item?.body?.form !== "source" ||
    item.body.revision !== refreshed.revision
  )
    return;
  store.setFeedItem(itemId, {
    ...item,
    body: { ...item.body, references: refreshed.references },
  });
}

/**
 * Every online direct open of a Document source asks once for fresher
 * Reference snapshots; the server decides whether the saved ones are young
 * enough. Failures keep the saved snapshots silently.
 */
export async function refreshFeedItemReferences(itemId: string) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  if (feedItemsStore.getState().feedItemsDict[itemId]?.body?.form !== "source")
    return;
  const refreshed = await orpcRouterClient.feedItem
    .refreshReferences({ id: itemId })
    .catch(() => null);
  if (!refreshed) return;
  applyRefreshedReferences(itemId, refreshed);
}
