import { discoverFeeds as discoverFeedsFromUrl } from "feedscout";

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
): Promise<DiscoveredFeed[]> {
  const [youtubeResult, feedscoutResult] = await Promise.allSettled([
    discoverYouTubeFeeds(url, read),
    discoverFeedsFromUrl(url, {
      methods: ["platform", "html", "headers", "guess"],
      concurrency: 2,
      maxUris: 8,
      includeInvalid: strict,
      fetchFn: async (targetUrl, options) => {
        const response = await read(targetUrl, {
          headers: options?.headers,
          method: options?.method,
        });
        if (
          strict &&
          !response.ok &&
          response.status !== 404 &&
          response.status !== 410
        )
          throw new Error(`Feed discovery request failed: ${response.status}`);
        return {
          headers: response.headers,
          body: response.text,
          url: response.url,
          status: response.status,
          statusText: response.statusText,
        };
      },
    }),
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
          (feed.method === "html" || feed.method === "headers" ||
            (feed.method !== "guess" && feed.error !== undefined)),
      );
      if (failedAdvertisedSource && !failedAdvertisedSource.isValid)
        throw failedAdvertisedSource.error ?? new Error("Unable to read the advertised Feed");
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

function requestReader() {
  const requests = new Map<string, ReturnType<typeof readFeedHttp>>();
  const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
  return ((url, options) => {
    const key = `${options?.method ?? "GET"}:${url}`;
    const existing = requests.get(key);
    if (existing) return existing;
    if (requests.size >= 24 || Date.now() >= deadline)
      return Promise.reject(new Error("Discovery request budget reached"));
    const value = readFeedHttp(url, {
      ...options,
      maxBodyBytes: 1024 * 1024,
      totalDurationMs: Math.min(5_000, deadline - Date.now()),
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
) {
  let target = new URL(url);
  const responses = await Promise.allSettled([
    read(url),
    read(new URL(STANDARD_SITE_WELL_KNOWN_PATH, target.origin).toString()),
  ]);
  const uris = new Set<string>();
  const page = responses[0];
  if (page?.status === "fulfilled" && page.value.ok) {
    const finalTarget = new URL(page.value.url);
    if (finalTarget.origin !== target.origin) {
      const [redirectedWellKnown] = await Promise.allSettled([
        read(
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
        return await resolvePublication(uri, signal);
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
    }
  }
  return rows;
}

async function discoverWebsite(
  url: string,
  read: typeof readFeedHttp,
  signal: AbortSignal,
  strict = false,
) {
  const [feeds, publications] = await Promise.all([
    discoverFeedsWithoutLimits(url, read, strict),
    websitePublications(url, read, signal, strict),
  ]);
  const candidates = new Map<string, SyndicationCandidate>();
  for await (const candidate of workerPool(
    feeds.slice(0, 8),
    2,
    async (row) => {
      try {
        const response = await read(row.url);
        if (!response.ok) {
          if (strict) throw new FeedImportDeferredError();
          return null;
        }
        const parsed = parseSyndicationFeed(response.text, row.url);
        return {
          row: {
            ...row,
            title: parsed.title || row.title,
            format: parsed.format,
            siteUrl: parsed.siteUrl,
            imageUrl: parsed.imageUrl,
          },
          hasFullBody: parsed.hasFullBody,
          itemUrls: parsed.items.slice(0, 20).map((item) => item.url),
        };
      } catch {
        if (strict) throw new FeedImportDeferredError();
        return { row, hasFullBody: false, itemUrls: [] };
      }
    },
  ))
    if (candidate) candidates.set(candidate.row.url, candidate);
  const ranked = collapseSyndicationAlternates(
    feeds.flatMap((row) =>
      candidates.get(row.url) ? [candidates.get(row.url)!] : [],
    ),
    url,
  );
  return combinePublicationRows(ranked, publications);
}

export async function discoverFeeds(
  userId: string,
  query: string,
): Promise<DiscoveredFeed[]> {
  const input = classifyDiscoveryInput(query);
  if (!input) return [];
  const lease = captureLimiter.acquire(userId, "discovery");
  if (!lease.ok) return [];
  try {
    const read = requestReader();
    const signal = AbortSignal.timeout(DISCOVERY_TOTAL_BUDGET_MS);
    if (input.publicationUri) {
      const publication = await resolvePublication(
        input.publicationUri,
        signal,
      );
      if (!publication) return [];
      const rows = await discoverWebsite(publication.siteUrl, read, signal);
      return combinePublicationRows(rows, [publicationRow(publication)]).slice(
        0,
        DISCOVERY_LIMIT,
      );
    }
    const [websites, publications] = await Promise.allSettled([
      input.websiteUrl
        ? discoverWebsite(input.websiteUrl, read, signal)
        : Promise.resolve([]),
      input.actorQuery
        ? searchPublications(input.actorQuery, signal)
        : Promise.resolve([]),
    ]);
    const websiteRows = websites.status === "fulfilled" ? websites.value : [];
    const actorRows =
      publications.status === "fulfilled"
        ? publications.value.slice(0, DISCOVERY_LIMIT).map(publicationRow)
        : [];
    const enriched = new Map<string, DiscoveredFeed>();
    const sites = [...new Set(actorRows.map((row) => row.siteUrl!))];
    for await (const result of workerPool(sites, 2, async (siteUrl) => {
      try {
        return { siteUrl, rows: await discoverWebsite(siteUrl, read, signal) };
      } catch {
        return { siteUrl, rows: [] };
      }
    })) {
      for (const row of combinePublicationRows(
        result.rows,
        actorRows.filter((actor) => actor.siteUrl === result.siteUrl),
      )) {
        const uri = row.origins?.find(
          (origin) => origin.kind === "atproto",
        )?.locator;
        if (uri) enriched.set(uri, row);
      }
    }
    return combinePublicationRows(
      websiteRows,
      actorRows.map((row) => enriched.get(row.origins![0]!.locator) ?? row),
    )
      .filter((row) => httpUrl(row.url))
      .slice(0, DISCOVERY_LIMIT);
  } catch (error) {
    captureException(error, { context: "publication-discovery" });
    return [];
  } finally {
    lease.release();
  }
}

/** Explicit revalidation must distinguish an unavailable site from an empty discovery. */
export async function discoverFeedOriginsForRevalidation(url: string) {
  const read = requestReader();
  const signal = AbortSignal.timeout(DISCOVERY_TOTAL_BUDGET_MS);
  const response = await read(url, undefined);
  if (!response.ok) throw new Error("Unable to read the Feed website");
  return discoverWebsite(url, read, signal, true);
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
    const signal = AbortSignal.timeout(DISCOVERY_TOTAL_BUDGET_MS);
    const page = await read(url);
    if (!page.ok) throw incomplete ?? new FeedImportDeferredError();
    const rows = await discoverWebsite(url, read, signal, true).catch(
      (error: unknown) => {
        throw incomplete ?? error;
      },
    );
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
