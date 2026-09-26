import { sanitizeEmbeddedHtml } from "@serial/standard-site";
import { and, eq, inArray } from "drizzle-orm";
import {
  FEED_ADD_MAX_DISCOVERED_FEEDS,
  FEED_INGESTION_CONCURRENCY,
} from "@serial/bookmark-capture";
import { runDatabaseWrite } from "../db/retry-write";
import { checkFeedItemIsVerticalFromUrl } from "../checkFeedItemIsVertical";
import { feedItems, feedOriginRss, feedOrigins } from "../db/schema";
import { buildConflictUpdateColumns } from "../db/utils";
import { logMessage } from "../logger";
import { toApplicationFeedItem } from "../feeds/reader-bodies";
import { enrichObservationImages } from "./observationImages";
import { calculateNextFetch } from "./calculateNextFetch";
import { getCachedFeedResult, setCachedFeedResult } from "./feedCache";
import { fetchNebulaFeedData, fetchNebulaFeedDetails } from "./parsers/nebula";
import { fetchPeerTubeFeedData } from "./parsers/peertube";
import { fetchUnknownRssFeed } from "./parsers/unknown";
import { fetchWebsiteFeedData } from "./parsers/website";
import {
  fetchYouTubeFeedData,
  fetchYouTubeFeedDetails,
} from "./parsers/youtube";
import { computeItemHash } from "./hash";
import { resolveItemDate } from "./publishedDate";
import { writeObservedItems } from "./writeItems";
import { rssObservation } from "./itemObservation";
import { refreshOriginMetadata } from "./originMetadata";
import { boundFeedItems } from "./feedBounds";
import { readFeedHttp } from "./feedHttp";
import { isAuthorizedTestRssUrl } from "./testRssOrigin";
import type { ApplicationFeedItem, DatabaseFeed } from "../db/schema";
import type { db as Database } from "../db";
import type {
  ConditionalHeaders,
  FeedFetchMetadata,
  FeedFetchResult,
  FetchableOrigin,
  NewFeedDetails,
  RSSContent,
  RSSFeedWithMetadata,
} from "./types";
import { normalizedBookmarkUrlOverride } from "~/server/bookmarks/url";
import {
  CONTENT_TYPE,
  contentMediumOf,
  isTextPlatform,
} from "~/lib/content/descriptor";
import { env } from "~/env";
import { dbSemaphore } from "~/lib/semaphore";
import { workerPool } from "~/lib/workerPool";

/** How long to back off a feed after a fetch error, to avoid cascading retries. */
const ERROR_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
export { FEED_INGESTION_CONCURRENCY } from "@serial/bookmark-capture";

export type FetchFeedsStatus = "success" | "empty" | "error" | "skipped";

function assertValidFeedUrl(url: string) {
  if (isAuthorizedTestRssUrl(url)) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error("Invalid URL", { cause: e });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Invalid URL protocol");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    (env.NODE_ENV === "production" && hostname === "localhost") ||
    hostname.endsWith(".localhost")
  ) {
    throw new Error("Localhost URLs are not allowed");
  }
  if (
    env.NODE_ENV === "production" &&
    /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  ) {
    throw new Error("Feeds hosted on IPV4 addresses are not allowed");
  }
}

export async function fetchNewFeedDetails(
  url: string,
): Promise<NewFeedDetails[]> {
  assertValidFeedUrl(url);

  let urls = [url];

  // process url
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname.toLowerCase();
  const isYouTubeHost =
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname.endsWith(".youtube.com");

  if (
    isYouTubeHost &&
    (url.includes("youtube.com/@") || url.includes("youtube.com/channel/"))
  ) {
    const feed = await readFeedHttp(url);
    if (!feed.ok) {
      throw new Error(
        `Failed to fetch YouTube channel page: ${feed.status} ${feed.statusText}`,
      );
    }
    const text = feed.text;

    const rssFeedUrlMatches = text.matchAll(
      /<link rel="alternate" type="application\/rss\+xml" title="RSS" href="(https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=[^&]{24})">/gm,
    );

    urls = Array.from(rssFeedUrlMatches).flatMap((id) =>
      id[1] ? [id[1]] : [],
    );
  }

  const feedDetailList: NewFeedDetails[] = [];
  for await (const feedDetails of workerPool(
    urls.slice(0, FEED_ADD_MAX_DISCOVERED_FEEDS),
    FEED_INGESTION_CONCURRENCY,
    async (feedUrl) => {
      assertValidFeedUrl(feedUrl);
      const feedHostname = new URL(feedUrl).hostname.toLowerCase();
      const isYouTube =
        feedHostname === "youtube.com" ||
        feedHostname === "www.youtube.com" ||
        feedHostname.endsWith(".youtube.com");
      if (isYouTube) {
        return fetchYouTubeFeedDetails(feedUrl);
      }
      if (
        feedHostname === "nebula.tv" ||
        feedHostname === "nebula.app" ||
        feedHostname.endsWith(".nebula.tv") ||
        feedHostname.endsWith(".nebula.app")
      ) {
        return fetchNebulaFeedDetails(feedUrl);
      }
      return fetchUnknownRssFeed(feedUrl);
    },
  )) {
    if (feedDetails) feedDetailList.push(feedDetails);
  }

  // get feeds
  return feedDetailList;
}

export type FeedResult = { metadataChanged?: boolean } & (
  | {
      status: "success";
      feedItems: ApplicationFeedItem[];
      removedItemIds?: string[];
      id: number;
      originId: number;
      fromCache?: boolean;
    }
  | {
      status: "empty" | "skipped";
      id: number;
      originId: number;
      fromCache?: boolean;
    }
  | {
      status: "error";
      id: number;
      originId: number;
      error: unknown;
      feedItems?: ApplicationFeedItem[];
      removedItemIds?: string[];
      fromCache?: boolean;
    }
);

type FetchStateUpdate = Pick<
  typeof feedOrigins.$inferInsert,
  "lastFetchedAt" | "nextFetchAt"
> &
  Pick<typeof feedOriginRss.$inferInsert, "etag" | "lastModifiedHeader">;

/** Every fetch-state write lands on the origin row, never on the Feed. */
async function writeOriginFetchState(
  context: { db: typeof Database },
  originId: number,
  update: FetchStateUpdate,
) {
  const { etag, lastModifiedHeader, ...schedule } = update;
  await runDatabaseWrite(context.db, () =>
    dbSemaphore.run(() =>
      context.db.transaction(async (tx) => {
        await tx
          .update(feedOrigins)
          .set(schedule)
          .where(eq(feedOrigins.id, originId));
        if (etag !== undefined || lastModifiedHeader !== undefined)
          await tx
            .update(feedOriginRss)
            .set({ etag, lastModifiedHeader })
            .where(eq(feedOriginRss.originId, originId));
      }),
    ),
  );
}

function fetchedState(
  now: Date,
  fetchMetadata: FeedFetchMetadata,
): FetchStateUpdate {
  return {
    lastFetchedAt: now,
    nextFetchAt: calculateNextFetch(fetchMetadata, now),
    etag: fetchMetadata.etag ?? null,
    lastModifiedHeader: fetchMetadata.lastModified ?? null,
  };
}

/** Distinct Feed rows behind a page of origins, in first-seen order. */
function uniqueFeeds(fetchableOrigins: FetchableOrigin[]): DatabaseFeed[] {
  const byId = new Map<number, DatabaseFeed>();
  for (const { feed } of fetchableOrigins) {
    if (!byId.has(feed.id)) byId.set(feed.id, feed);
  }
  return [...byId.values()];
}

async function insertFeedItems(
  context: { db: typeof Database },
  feedId: number,
  items: RSSContent[],
  databaseFeeds: DatabaseFeed[],
): Promise<ApplicationFeedItem[]> {
  if (!items.length) {
    return [];
  }

  const targetFeed = databaseFeeds.find((feed) => feed.id === feedId);
  const feedContentType =
    targetFeed ? contentMediumOf(targetFeed.platform) : CONTENT_TYPE.VIDEO;
  const feedItemList: Array<typeof feedItems.$inferInsert> = items.map(
    (item) => {
      let normalizedUrl: string | null = null;
      try {
        normalizedUrl = normalizedBookmarkUrlOverride(item.url);
      } catch {
        // Invalid item URLs retain their existing Feed behavior but cannot
        // keep the normalized URL stable for identity and cache matching.
      }
      return {
        feedId,
        contentId: item.id,
        content: sanitizeEmbeddedHtml(item.content ?? ""),
        bodySource: item.content ? "rss" : "none",
        contentSnippet: item.contentSnippet,
        contentType: feedContentType,
        title: item.title,
        author: item.author,
        thumbnail: item.thumbnail,
        url: item.url,
        normalizedUrl,
        postedAt: new Date(item.publishedDate),
        orientation: checkFeedItemIsVerticalFromUrl(item.url),
      } satisfies typeof feedItems.$inferInsert;
    },
  );

  // Diff against existing hashes to avoid unnecessary writes.
  const incomingUrls = feedItemList.map((item) => item.url);
  const existingItems = await dbSemaphore.run(() =>
    context.db
      .select({
        url: feedItems.url,
        contentHash: feedItems.contentHash,
        normalizedUrl: feedItems.normalizedUrl,
        postedAt: feedItems.postedAt,
      })
      .from(feedItems)
      .where(
        and(eq(feedItems.feedId, feedId), inArray(feedItems.url, incomingUrls)),
      )
      .all(),
  );

  const existingByUrl = new Map(existingItems.map((item) => [item.url, item]));

  const firstSeenAt = new Date();
  const feedItemListWithHash = feedItemList.map((item) => {
    // Undated items retain their first-seen time across refreshes and edits.
    const datedItem = {
      ...item,
      postedAt: resolveItemDate(
        item.postedAt,
        existingByUrl.get(item.url)?.postedAt,
        firstSeenAt,
      ),
    };
    return { ...datedItem, contentHash: computeItemHash(datedItem) };
  });

  const changedItems = feedItemListWithHash.filter((incoming) => {
    const existing = existingByUrl.get(incoming.url);
    if (!existing) return true; // new item
    // Refresh pre-migration hashes and sparse normalization overrides even
    // when the Feed content itself is otherwise unchanged.
    return (
      existing.contentHash !== incoming.contentHash ||
      (existing.normalizedUrl ?? null) !== incoming.normalizedUrl
    );
  });

  if (changedItems.length === 0) {
    return [];
  }

  const feedItemsList = (
    await runDatabaseWrite(context.db, () =>
      dbSemaphore.run(() =>
        context.db
          .insert(feedItems)
          .values(changedItems)
          .onConflictDoUpdate({
            target: [feedItems.url, feedItems.feedId],
            set: buildConflictUpdateColumns(feedItems, [
              "author",
              "content",
              "bodySource",
              "contentHash",
              "contentId",
              "contentSnippet",
              "contentType",
              "normalizedUrl",
              "createdAt",
              "orientation",
              "postedAt",
              "thumbnail",
              "title",
              "url",
            ]),
          })
          .returning(),
      ),
    )
  )
    .filter(Boolean)
    .flat();

  return feedItemsList.map((item) => {
    const itemFeed = databaseFeeds.find((f) => f.id === item.feedId);
    return toApplicationFeedItem(item, itemFeed?.platform ?? "youtube");
  });
}

export async function* fetchAndInsertFeedData(
  context: { db: typeof Database; manual?: boolean; drain?: boolean },
  fetchableOrigins: FetchableOrigin[],
) {
  const now = new Date();
  const databaseFeeds = uniqueFeeds(fetchableOrigins);

  const fetchOrigin = async (
    fetchable: FetchableOrigin,
  ): Promise<FeedResult> => {
    const { origin, feed } = fetchable;
    const ids = { id: feed.id, originId: origin.id };
    try {
      // Check if we should skip this origin based on nextFetchAt
      if (origin.nextFetchAt && origin.nextFetchAt > now) {
        return { status: "skipped", ...ids };
      }

      if (!feed.isActive) {
        return { status: "skipped", ...ids };
      }

      if (origin.kind === "atproto") {
        const { refreshStreamOrigin } = await import("../jetstream/service");
        return await refreshStreamOrigin(context.db, fetchable, {
          drain: context.drain,
        });
      }

      const writeItems = async (data: RSSFeedWithMetadata) => {
        if (isTextPlatform(feed.platform)) {
          const metadataChanged = await refreshOriginMetadata(
            context.db,
            fetchable,
            {
              name: data.title,
              imageUrl: data.imageUrl,
              description: data.description,
              siteUrl: data.url,
            },
          );
          const observations = boundFeedItems(data.items).flatMap((item) => {
            try {
              return [rssObservation(item)];
            } catch {
              return [];
            }
          });
          const written = await writeObservedItems(
            context.db,
            feed,
            await enrichObservationImages(observations),
          );
          return {
            feedItems: written.items,
            removedItemIds: written.removedItemIds,
            metadataChanged,
          };
        }
        return {
          feedItems: await insertFeedItems(
            context,
            feed.id,
            boundFeedItems(data.items),
            databaseFeeds,
          ),
        };
      };

      // Check cross-user cache
      const cachedResult = await getCachedFeedResult(origin.locator);

      if (cachedResult) {
        if (cachedResult.status === "error") {
          await writeOriginFetchState(context, origin.id, {
            nextFetchAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
          });
          return {
            status: "error",
            ...ids,
            error: new Error(cachedResult.message),
            fromCache: true,
          };
        }

        if (cachedResult.status === "empty") {
          const written = await writeItems({
            ...cachedResult.data,
            id: feed.id,
            items: [],
            fetchMetadata: cachedResult.fetchMetadata,
          });
          await writeOriginFetchState(
            context,
            origin.id,
            fetchedState(now, cachedResult.fetchMetadata),
          );
          return {
            status: "empty",
            ...ids,
            fromCache: true,
            metadataChanged:
              "metadataChanged" in written ? written.metadataChanged : false,
          };
        }

        // cached success
        const written = await writeItems({ ...cachedResult.data, id: feed.id });
        await writeOriginFetchState(
          context,
          origin.id,
          fetchedState(now, cachedResult.data.fetchMetadata),
        );

        return {
          status: "success",
          ...written,
          ...ids,
          fromCache: true,
        };
      }

      // Cache miss — proceed with HTTP fetch
      const cached: ConditionalHeaders = {
        etag: origin.rss?.etag,
        lastModifiedHeader: origin.rss?.lastModifiedHeader,
      };

      let feedData: FeedFetchResult | null = null;

      if (feed.platform === "youtube") {
        feedData = await fetchYouTubeFeedData(fetchable, cached);
      } else if (feed.platform === "peertube") {
        feedData = await fetchPeerTubeFeedData(fetchable, cached);
      } else if (feed.platform === "nebula") {
        feedData = await fetchNebulaFeedData(fetchable, cached);
      } else if (isTextPlatform(feed.platform)) {
        // Every text Feed's RSS origin is a plain syndication feed.
        feedData = await fetchWebsiteFeedData(fetchable, cached);
      }

      if (!feedData) {
        await writeOriginFetchState(context, origin.id, {
          nextFetchAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
        });
        const error = new Error(
          `No feed data returned for platform: ${feed.platform}`,
        );
        await setCachedFeedResult(origin.locator, {
          status: "error",
          message: error.message,
        });
        return { status: "error", ...ids, error };
      }

      // Handle 304 Not Modified — skip insert, just update timestamps
      if ("notModified" in feedData && feedData.notModified) {
        await writeOriginFetchState(context, origin.id, {
          lastFetchedAt: now,
          nextFetchAt: calculateNextFetch(feedData.fetchMetadata, now),
        });
        return { status: "skipped", ...ids };
      }

      // At this point feedData is a full RSSFeedWithMetadata (not notModified)
      const completedFeed = feedData as RSSFeedWithMetadata;

      if (!completedFeed.items.length) {
        const written = await writeItems(completedFeed);
        await setCachedFeedResult(origin.locator, {
          status: "empty",
          fetchMetadata: completedFeed.fetchMetadata,
          data: {
            title: completedFeed.title,
            url: completedFeed.url,
            imageUrl: completedFeed.imageUrl,
            description: completedFeed.description,
          },
        });
        await writeOriginFetchState(
          context,
          origin.id,
          fetchedState(now, completedFeed.fetchMetadata),
        );
        return {
          status: "empty",
          ...ids,
          metadataChanged:
            "metadataChanged" in written ? written.metadataChanged : false,
        };
      }

      await setCachedFeedResult(origin.locator, {
        status: "success",
        data: {
          title: completedFeed.title,
          imageUrl: completedFeed.imageUrl,
          description: completedFeed.description,
          url: completedFeed.url,
          items: completedFeed.items,
          fetchMetadata: completedFeed.fetchMetadata,
        },
      });

      const written = await writeItems(completedFeed);
      await writeOriginFetchState(
        context,
        origin.id,
        fetchedState(now, completedFeed.fetchMetadata),
      );
      return { status: "success", ...written, ...ids };
    } catch (e) {
      // Push back nextFetchAt so a broken origin isn't retried every minute
      try {
        await writeOriginFetchState(context, origin.id, {
          nextFetchAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
        });
      } catch {
        // Best-effort — don't let the backoff update mask the original error
      }
      await setCachedFeedResult(origin.locator, {
        status: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      return { status: "error", ...ids, error: e };
    }
  };

  let skippedCount = 0;
  let crossUserCacheCount = 0;
  let fetchedCount = 0;
  const totalFeeds = fetchableOrigins.length;
  const fetchedFeedNames: string[] = [];
  const feedNameById = new Map(
    databaseFeeds.map((feed) => [feed.id, feed.name]),
  );

  for await (const result of workerPool(
    fetchableOrigins,
    FEED_INGESTION_CONCURRENCY,
    fetchOrigin,
  )) {
    if (result.status === "skipped") {
      skippedCount++;
    } else if (result.fromCache) {
      crossUserCacheCount++;
    } else {
      fetchedCount++;
      const feedName = feedNameById.get(result.id);
      if (feedName) {
        fetchedFeedNames.push(feedName);
      }
    }

    yield result;
  }

  // Log fetch statistics
  if (totalFeeds > 0) {
    const cacheHitPercent = ((crossUserCacheCount / totalFeeds) * 100).toFixed(
      1,
    );
    logMessage(
      `[Feed Fetch] ${skippedCount} skipped, ${crossUserCacheCount} cross-user cached (${cacheHitPercent}%), ${fetchedCount} fetched out of ${totalFeeds} origins; workers=${Math.min(FEED_INGESTION_CONCURRENCY, totalFeeds)}, queued=${Math.max(0, totalFeeds - FEED_INGESTION_CONCURRENCY)}`,
    );
  }

  return;
}
