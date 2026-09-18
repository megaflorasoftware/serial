import { JSDOM } from "jsdom";
import {
  classifyDiscoveryInput,
  collapseSyndicationAlternates,
  combinePublicationRows,
  DISCOVERY_LIMIT,
  DISCOVERY_TOTAL_BUDGET_MS,
  httpUrl,
} from "@serial/feed-discovery";
import {
  STANDARD_SITE_LINK_REL,
  STANDARD_SITE_WELL_KNOWN_PATH,
} from "@serial/standard-site";
import { FeedImportDeferredError } from "./importErrors";
import { discoverRssFeeds } from "./discoverRss";
import {
  DISCOVERY_PRIMARY_REQUEST_MS,
  DISCOVERY_PUBLICATION_HINT_MS,
  withDiscoveryReadBudget,
} from "./discoveryBudgets";
import {
  publicationRow,
  resolvePublication,
  searchPublications,
} from "./publications";
import type {
  DiscoveredFeed,
  SyndicationCandidate,
} from "@serial/feed-discovery";
import { captureLimiter } from "~/server/bookmarks/limits";
import { captureException } from "~/server/logger";
import { readFeedHttp } from "~/server/rss/feedHttp";

import { parseSyndicationFeed } from "~/server/rss/syndication";
import { workerPool } from "~/lib/workerPool";

export type { DiscoveredFeed } from "@serial/feed-discovery";

async function discoverYouTubeFeeds(url: string, read: typeof readFeedHttp) {
  if (!url.includes("youtube.com/@") && !url.includes("youtube.com/channel/")) {
    return null;
  }

  try {
    const response = await read(url);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Failed to fetch YouTube channel page: ${response.status} ${response.statusText}`,
      );
    }
    const text = response.text;
    const rssFeedUrlMatches = text.matchAll(
      /<link rel="alternate" type="application\/rss\+xml" title="RSS" href="(https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=[^&]{24})">/gm,
    );
    const channelName = /<meta property="og:title" content="([^"]+)">/.exec(
      text,
    )?.[1];
    const feedUrls = Array.from(rssFeedUrlMatches).flatMap((match) =>
      match[1] ? [match[1]] : [],
    );

    return feedUrls.length > 0
      ? feedUrls.map((feedUrl) => ({
          url: feedUrl,
          title: channelName,
          format: "atom" as const,
        }))
      : null;
  } catch (error) {
    captureException(error, { context: "youtube-feed-discovery", url });
    return null;
  }
}

async function discoverFeedsWithoutLimits(
  url: string,
  read: typeof readFeedHttp,
  strict = false,
  onFeed?: (feed: DiscoveredFeed) => Promise<void>,
): Promise<DiscoveredFeed[]> {
  const [youtubeResult, feedscoutResult] = await Promise.allSettled([
    discoverYouTubeFeeds(url, read),
    discoverRssFeeds(url, read, strict, onFeed),
  ]);
  const discoveredFeeds: DiscoveredFeed[] = [];

  if (youtubeResult.status === "fulfilled" && youtubeResult.value) {
    discoveredFeeds.push(...youtubeResult.value);
  } else if (youtubeResult.status === "rejected") {
    captureException(youtubeResult.reason, {
      context: "feed-discovery-youtube",
      url,
    });
  }

  if (feedscoutResult.status === "fulfilled") {
    if (strict) {
      const failedAdvertisedSource = feedscoutResult.value.find(
        (feed) =>
          !feed.isValid &&
          (feed.method === "html" ||
            feed.method === "headers" ||
            (feed.method !== "guess" && feed.error !== undefined)),
      );
      if (failedAdvertisedSource && !failedAdvertisedSource.isValid)
        throw (
          failedAdvertisedSource.error ??
          new Error("Unable to read the advertised Feed")
        );
    }
    discoveredFeeds.push(
      ...feedscoutResult.value.filter((feed) => feed.isValid),
    );
  } else {
    if (strict) throw feedscoutResult.reason;
    captureException(feedscoutResult.reason, {
      context: "feed-discovery-feedscout",
      url,
    });
  }

  const seen = new Set<string>();
  return discoveredFeeds.filter((feed) => {
    if (seen.has(feed.url)) return false;
    seen.add(feed.url);
    return !(
      feed.url.includes("youtube.com") && !feed.url.includes("channel_id=")
    );
  });
}

function requestReader(signal?: AbortSignal) {
  const requests = new Map<string, ReturnType<typeof readFeedHttp>>();
  const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
  return ((url, options) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const key = `${options?.method ?? "GET"}:${url}`;
    const existing = requests.get(key);
    if (existing) return existing;
    if (requests.size >= 24 || Date.now() >= deadline)
      return Promise.reject(new Error("Discovery request budget reached"));
    const value = readFeedHttp(url, {
      ...options,
      signal,
      maxBodyBytes: 1024 * 1024,
      totalDurationMs: Math.min(
        options?.totalDurationMs ?? DISCOVERY_PRIMARY_REQUEST_MS,
        DISCOVERY_PRIMARY_REQUEST_MS,
        deadline - Date.now(),
      ),
    });
    requests.set(key, value);
    return value;
  }) satisfies typeof readFeedHttp;
}

async function websitePublications(
  url: string,
  read: typeof readFeedHttp,
  signal: AbortSignal,
  strict = false,
  onUpdate?: (rows: DiscoveredFeed[]) => void,
  deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS,
) {
  let target = new URL(url);
  const readHint =
    strict || onUpdate
      ? read
      : withDiscoveryReadBudget(read, DISCOVERY_PUBLICATION_HINT_MS);
  const responses = await Promise.allSettled([
    read(url),
    readHint(new URL(STANDARD_SITE_WELL_KNOWN_PATH, target.origin).toString()),
  ]);
  const uris = new Set<string>();
  const page = responses[0];
  if (page?.status === "fulfilled" && page.value.ok) {
    const finalTarget = new URL(page.value.url);
    if (finalTarget.origin !== target.origin) {
      const [redirectedWellKnown] = await Promise.allSettled([
        readHint(
          new URL(STANDARD_SITE_WELL_KNOWN_PATH, finalTarget.origin).toString(),
        ),
      ]);
      if (redirectedWellKnown) responses.push(redirectedWellKnown);
    }
    target = finalTarget;
  }
  if (
    page?.status === "fulfilled" &&
    page.value.ok &&
    !page.value.text.trimStart().startsWith("{")
  ) {
    const document = new JSDOM(page.value.text.slice(0, 512 * 1024), {
      url: page.value.url,
    });
    for (const link of document.window.document.querySelectorAll(
      "link[rel][href]",
    )) {
      if (
        link
          .getAttribute("rel")
          ?.split(/\s+/)
          .includes(STANDARD_SITE_LINK_REL.publication)
      ) {
        const href = link.getAttribute("href");
        if (href) uris.add(href);
      }
      if (uris.size >= 4) break;
    }
    document.window.close();
  }
  for (const wellKnown of responses.slice(1)) {
    if (strict && wellKnown.status === "rejected") throw wellKnown.reason;
    if (wellKnown.status === "fulfilled" && wellKnown.value.ok) {
      const uri = wellKnown.value.text.trim();
      if (uri.length <= 1024 && uri.startsWith("at://")) uris.add(uri);
    } else if (
      strict &&
      wellKnown.status === "fulfilled" &&
      wellKnown.value.status !== 404 &&
      wellKnown.value.status !== 410
    ) {
      throw new Error(
        `Publication discovery request failed: ${wellKnown.value.status}`,
      );
    }
  }
  const rows: DiscoveredFeed[] = [];
  for await (const result of workerPool(
    [...uris].slice(0, 4),
    2,
    async (uri) => {
      try {
        return await resolvePublication(uri, signal, deadline);
      } catch (error) {
        if (strict) throw error;
        return null;
      }
    },
  )) {
    if (!result) continue;
    const site = new URL(result.siteUrl);
    if (
      site.origin === target.origin &&
      (target.pathname === "/" ||
        target.pathname === site.pathname ||
        target.pathname.startsWith(`${site.pathname.replace(/\/$/, "")}/`))
    ) {
      rows.push(publicationRow(result));
      onUpdate?.(rows);
    }
  }
  return rows;
}

async function discoverWebsite(
  url: string,
  read: typeof readFeedHttp,
  signal: AbortSignal,
  strict = false,
  onUpdate?: (rows: DiscoveredFeed[]) => void,
  deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS,
) {
  const candidates = new Map<string, SyndicationCandidate>();
  let publications: DiscoveredFeed[] = [];
  const snapshot = () =>
    combinePublicationRows(
      collapseSyndicationAlternates([...candidates.values()], url),
      publications,
    );
  const addCandidate = async (row: DiscoveredFeed) => {
    if (signal.aborted) {
      if (strict) signal.throwIfAborted();
      return;
    }
    if (candidates.has(row.url)) return;
    try {
      const response = await read(row.url);
      if (!response.ok) {
        if (strict) throw new Error("Unable to read the RSS Feed");
        return;
      }
      const parsed = parseSyndicationFeed(response.text, row.url);
      candidates.set(row.url, {
        row: {
          ...row,
          title: parsed.title || row.title,
          format: parsed.format,
          siteUrl: parsed.siteUrl,
          imageUrl: parsed.imageUrl,
        },
        hasFullBody: parsed.hasFullBody,
        itemUrls: parsed.items.slice(0, 20).map((item) => item.url),
      });
    } catch (error) {
      if (strict) throw error;
      candidates.set(row.url, { row, hasFullBody: false, itemUrls: [] });
    }
    if (!signal.aborted) onUpdate?.(snapshot());
  };
  const [feeds] = await Promise.all([
    discoverFeedsWithoutLimits(
      url,
      read,
      strict,
      onUpdate ? addCandidate : undefined,
    ),
    websitePublications(
      url,
      read,
      signal,
      strict,
      onUpdate
        ? (rows) => {
            publications = rows;
            onUpdate(snapshot());
          }
        : undefined,
      deadline,
    ).then((rows) => {
      publications = rows;
    }),
  ]);
  for await (const result of workerPool(feeds.slice(0, 8), 2, addCandidate)) {
    void result;
  }
  if (strict) signal.throwIfAborted();
  return snapshot();
}

type DiscoveryUpdate = (rows: DiscoveredFeed[]) => void;

async function runDiscovery(
  userId: string,
  query: string,
  onUpdate?: DiscoveryUpdate,
  callerSignal?: AbortSignal,
): Promise<DiscoveredFeed[]> {
  const input = classifyDiscoveryInput(query);
  if (!input || callerSignal?.aborted) return [];
  const lease = captureLimiter.acquire(userId, "discovery");
  if (!lease.ok) return [];
  const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DISCOVERY_TOTAL_BUDGET_MS,
  );
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const read = requestReader(signal);
  let latest: DiscoveredFeed[] = [];
  let wakeOnAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    wakeOnAbort = resolve;
  });
  signal.addEventListener("abort", wakeOnAbort, { once: true });
  const websiteRows = new Map<string, DiscoveredFeed[]>();
  const websites = new Map<string, Promise<DiscoveredFeed[]>>();
  let actors: DiscoveredFeed[] = [];
  const publish = () => {
    if (signal.aborted) return;
    const enriched = new Map<string, DiscoveredFeed>();
    for (const site of new Set(actors.map((actor) => actor.siteUrl!))) {
      const rows = combinePublicationRows(
        websiteRows.get(site) ?? [],
        actors.filter((actor) => actor.siteUrl === site),
      );
      for (const row of rows) {
        const uri = row.origins?.find(
          (origin) => origin.kind === "atproto",
        )?.locator;
        if (uri) enriched.set(uri, row);
      }
    }
    latest = combinePublicationRows(
      websiteRows.get(input.websiteUrl ?? "") ?? [],
      actors.map((actor) => enriched.get(actor.origins![0]!.locator) ?? actor),
    )
      .filter((row) => httpUrl(row.url))
      .slice(0, DISCOVERY_LIMIT);
    onUpdate?.(latest);
  };
  const website = (url: string) => {
    const existing = websites.get(url);
    if (existing) return existing;
    if (signal.aborted) return Promise.resolve([]);
    const update = (rows: DiscoveredFeed[]) => {
      if (signal.aborted) return;
      websiteRows.set(url, rows);
      publish();
    };
    const pending = discoverWebsite(
      url,
      read,
      signal,
      false,
      onUpdate ? update : undefined,
      deadline,
    )
      .then((rows) => {
        update(rows);
        return rows;
      })
      .catch(() => websiteRows.get(url) ?? []);
    websites.set(url, pending);
    return pending;
  };
  const work = async () => {
    if (input.publicationUri) {
      const publication = await resolvePublication(
        input.publicationUri,
        signal,
        deadline,
      );
      if (!publication || signal.aborted) return;
      actors = [publicationRow(publication)];
      publish();
      await website(publication.siteUrl);
    } else {
      await Promise.allSettled([
        input.websiteUrl ? website(input.websiteUrl) : Promise.resolve([]),
        (async () => {
          if (!input.actorQuery) return;
          const publications = await searchPublications(
            input.actorQuery,
            signal,
          );
          if (signal.aborted) return;
          actors = publications.slice(0, DISCOVERY_LIMIT).map(publicationRow);
          publish();
          const sites = [...new Set(actors.map((row) => row.siteUrl!))];
          for await (const result of workerPool(sites, 2, website)) {
            void result;
          }
        })(),
      ]);
    }
    publish();
  };
  try {
    await Promise.race([work(), aborted]);
    return latest;
  } catch (error) {
    if (!signal.aborted)
      captureException(error, { context: "publication-discovery" });
    return latest;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", wakeOnAbort);
    controller.abort();
    lease.release();
  }
}

/** Completed-array consumers retain the short interactive probing budgets. */
export function discoverFeeds(userId: string, query: string) {
  return runDiscovery(userId, query);
}

/** Finite request-scoped SSE; coalesce snapshots for slow consumers. */
export async function* streamDiscoverFeeds(
  userId: string,
  query: string,
  callerSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  let latest: DiscoveredFeed[] = [];
  let changed = false;
  let done = false;
  let wake: (() => void) | undefined;
  let serialized = "";
  const pending = runDiscovery(
    userId,
    query,
    (rows) => {
      const next = JSON.stringify(rows);
      if (serialized === next) return;
      serialized = next;
      latest = rows;
      changed = true;
      wake?.();
    },
    signal,
  ).then((rows) => {
    latest = rows;
    done = true;
    wake?.();
  });
  try {
    while (!done) {
      if (changed) {
        changed = false;
        yield { feeds: latest, complete: false };
      }
      if (!done && !changed)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
    if (!signal.aborted) yield { feeds: latest, complete: true };
  } finally {
    controller.abort();
    await pending;
  }
}

/** Explicit revalidation must distinguish an unavailable site from an empty discovery. */
export async function discoverFeedOriginsForRevalidation(url: string) {
  const read = requestReader();
  const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
  const signal = AbortSignal.timeout(DISCOVERY_TOTAL_BUDGET_MS);
  const response = await read(url, undefined);
  if (!response.ok) throw new Error("Unable to read the Feed website");
  return discoverWebsite(url, read, signal, true, undefined, deadline);
}

/** Imports require completed discovery; an unavailable source is never evidence of absence. */
export async function discoverFeedOriginsForImport(
  userId: string,
  url: string,
) {
  const lease = captureLimiter.acquire(userId, "discovery");
  if (!lease.ok) {
    throw new FeedImportDeferredError(
      undefined,
      new Date(
        Date.now() + (lease.reason === "rate_limited" ? 600_000 : 60_000),
      ),
    );
  }
  try {
    const request = requestReader();
    let incomplete: FeedImportDeferredError | undefined;
    const read: typeof readFeedHttp = async (target, options) => {
      try {
        const response = await request(target, options);
        // Missing guessed endpoints are normal. Other HTTP failures leave discovery incomplete.
        if (
          !response.ok &&
          response.status !== 404 &&
          response.status !== 410
        ) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const retryAt = Number.isFinite(seconds)
            ? Date.now() + Math.max(0, seconds) * 1000
            : Date.parse(retryAfter ?? "");
          incomplete = new FeedImportDeferredError(
            undefined,
            new Date(
              Math.max(
                Date.now() + 60_000,
                Number.isFinite(retryAt) ? retryAt : 0,
                incomplete?.retryAt.getTime() ?? 0,
              ),
            ),
          );
        }
        return response;
      } catch (error) {
        incomplete ??= new FeedImportDeferredError();
        throw error;
      }
    };
    const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
    const signal = AbortSignal.timeout(DISCOVERY_TOTAL_BUDGET_MS);
    const page = await read(url);
    if (!page.ok) throw incomplete ?? new FeedImportDeferredError();
    const rows = await discoverWebsite(
      url,
      read,
      signal,
      true,
      undefined,
      deadline,
    ).catch((error: unknown) => {
      throw incomplete ?? error;
    });
    if (incomplete || signal.aborted)
      throw incomplete ?? new FeedImportDeferredError();
    return rows;
  } catch (error) {
    if (error instanceof FeedImportDeferredError) throw error;
    throw new FeedImportDeferredError();
  } finally {
    lease.release();
  }
}
