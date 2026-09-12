"use client";

import { unstable_batchedUpdates } from "react-dom";
import { createFrameBatch } from "../frameBatch";
import { orpc, orpcRouterClient } from "../orpc";
import { getQueryClient } from "../query-client";
import { feedsStore } from "./feeds/store";
import {
  getMixedContentMembershipRevision,
  isMixedContentMembershipRevisionStale,
} from "./mixed-content/membershipRevision";
import { loadingActor } from "./loading-machine";
import { dataReconciliation } from "./reconciliation";
import { applyRequestedMixedContentPage } from "./subscriptionCoordinator";
import { feedItemsStore } from "./store";
import { viewsStore } from "./views/store";
import type { ContentStatusFilter } from "~/lib/content-status";
import type { ImportProgressChunk } from "~/server/api/routers/initialRouter";
import type { ApplicationFeed, ApplicationView } from "~/server/db/schema";

type FeedStatusChunk = Extract<ImportProgressChunk, { type: "feed-status" }>;

function applyFeedStatusChunks(chunks: FeedStatusChunk[]) {
  if (chunks.length === 0) return;
  const feedStatusDict = { ...feedItemsStore.getState().feedStatusDict };
  for (const chunk of chunks) feedStatusDict[chunk.feedId] = chunk.status;
  feedItemsStore.setState({ feedStatusDict });
  loadingActor.send({ type: "FEED_STATUS_BATCH", count: chunks.length });
}

function applyImportedFeeds(feeds: ApplicationFeed[]) {
  if (feeds.length === 0) return;
  feedsStore.getState().addMany(feeds);
}

function applyImportedViews(views: ApplicationView[] | undefined) {
  if (!views) return;
  // Authoritative server state: mark it a success so it renders even if a
  // concurrent fetch later fails. An in-flight fetch is unaffected — the
  // revision bump from set() makes it refetch rather than apply a stale
  // response.
  viewsStore.getState().set(views);
  viewsStore.setState({ fetchStatus: "success" });
}

/**
 * Applies a burst of import chunks as one store write per store. Feeds and
 * statuses are coalesced, only the last views chunk is kept, and every control
 * chunk (start, warning, error) first flushes what came before it so the
 * loading machine sees events in the order the server emitted them.
 */
export function applyImportProgressChunks(chunks: ImportProgressChunk[]) {
  let feeds: ApplicationFeed[] = [];
  let statuses: FeedStatusChunk[] = [];
  let views: ApplicationView[] | undefined;

  const flushCoalesced = () => {
    applyImportedFeeds(feeds);
    applyImportedViews(views);
    applyFeedStatusChunks(statuses);
    feeds = [];
    statuses = [];
    views = undefined;
  };

  unstable_batchedUpdates(() => {
    for (const chunk of chunks) {
      switch (chunk.type) {
        case "import-feed-inserted":
          feeds.push(chunk.feed);
          break;
        case "import-views-updated":
          views = chunk.views;
          break;
        case "feed-status":
          statuses.push(chunk);
          break;
        case "import-start":
          flushCoalesced();
          feedItemsStore.setState({ hasInitialData: true, feedStatusDict: {} });
          loadingActor.send({
            type: "IMPORT_START",
            totalFeeds: chunk.totalFeeds,
          });
          break;
        case "import-limit-warning":
          flushCoalesced();
          loadingActor.send({
            type: "IMPORT_LIMIT_WARNING",
            deactivatedCount: chunk.deactivatedCount,
            maxActiveFeeds: chunk.maxActiveFeeds,
          });
          break;
        case "import-feed-error":
          flushCoalesced();
          console.error(`Import error for ${chunk.feedUrl}: ${chunk.error}`);
          loadingActor.send({
            type: "IMPORT_FEED_ERROR",
            feedUrl: chunk.feedUrl,
          });
          break;
      }
    }
    flushCoalesced();
  });
}

export const dataRequestActions = {
  requestMixedContentPage: (
    scope: Parameters<
      typeof orpcRouterClient.mixedContent.requestPage
    >[0]["scope"],
    contentStatus: ContentStatusFilter,
    cursor?: Parameters<
      typeof orpcRouterClient.mixedContent.requestPage
    >[0]["cursor"],
    limit?: number,
  ) => {
    const membershipRevision = getMixedContentMembershipRevision();
    return orpcRouterClient.mixedContent
      .requestPage({ scope, contentStatus, cursor, limit })
      .then((page) => {
        if (isMixedContentMembershipRevisionStale(membershipRevision)) {
          return page;
        }
        applyRequestedMixedContentPage({
          scope,
          contentStatus,
          page,
          replacesScope: !cursor,
        });
        return page;
      });
  },
  streamingImport: (
    feeds: Array<{
      feedUrl: string;
      categories: string[];
      categoryPaths?: Array<
        Array<{
          name: string;
          type?: "view" | "tag" | "feed";
          feedUrl?: string;
        }>
      >;
      tagNames?: string[];
    }>,
  ) =>
    orpcRouterClient.initial.streamingImport({ feeds }).then(async (stream) => {
      // Chunks decoded from one network read arrive back to back; applying
      // them per frame turns a burst into one render instead of one each.
      const progress = createFrameBatch(applyImportProgressChunks);
      try {
        for await (const chunk of stream) progress.push(chunk);
        progress.flush();
      } catch (error) {
        // Apply whatever arrived before the failure so the stores match the
        // server, then let the original error win.
        try {
          progress.flush();
        } catch {
          // Already failing; the first error is the one to report.
        }
        throw error;
      } finally {
        loadingActor.send({ type: "IMPORT_COMPLETE" });
        // The imported views land in the store via import-views-updated
        // chunks, but their first content pages only load through a full
        // reconciliation — and the SSE invalidations alone leave that to a
        // later repair (or a reconnect if the connection dropped). Request it
        // directly so the new views become browsable right away.
        dataReconciliation.requestManualFull().catch(() => {
          // A superseded or failed full sync will be retried by the runtime.
        });
        await getQueryClient().invalidateQueries({
          queryKey: orpc.subscription.getStatus.queryOptions().queryKey,
        });
      }
    }),
};
