import type { ApplicationFeedItem } from "~/server/db/schema";

type ClientManifestEntry = { id: string; contentHash: string | null };

/**
 * Builds per-view, per-visibility-filter manifests from the client's cached
 * feed items. The server uses these manifests to diff against its own data
 * and only send what changed.
 *
 * Items are bucketed by visibility (unread / read / later) so the server
 * doesn't mark e.g. read items as "deleted" during the unread diff.
 */
export function buildViewManifests(state: {
  feedItemsDict: Record<string, ApplicationFeedItem>;
  viewFeedIds: Record<number, number[]>;
}): Record<number, Record<string, ClientManifestEntry[]>> {
  const { feedItemsDict, viewFeedIds } = state;

  const viewManifests: Record<
    number,
    Record<string, ClientManifestEntry[]>
  > = {};

  for (const [viewIdStr, feedIds] of Object.entries(viewFeedIds)) {
    const viewId = Number(viewIdStr);
    const feedIdSet = new Set(feedIds);
    const unread: ClientManifestEntry[] = [];
    const read: ClientManifestEntry[] = [];
    const later: ClientManifestEntry[] = [];

    for (const [id, item] of Object.entries(feedItemsDict)) {
      if (!feedIdSet.has(item.feedId)) continue;
      const entry: ClientManifestEntry = {
        id,
        contentHash: item.contentHash ?? null,
      };

      if (item.isWatchLater) {
        later.push(entry);
      } else if (item.isWatched) {
        read.push(entry);
      } else {
        unread.push(entry);
      }
    }

    viewManifests[viewId] = { unread, read, later };
  }

  return viewManifests;
}
