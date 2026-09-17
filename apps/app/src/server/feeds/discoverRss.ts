import { discoverFeeds as scoutFeeds } from "feedscout";
import { defaultExtractFn, defaultGuessOptions } from "feedscout/feeds";
import { discoverUrisFromGuess } from "feedscout/methods";
import {
  DISCOVERY_GUESS_REQUEST_MS,
  DISCOVERY_GUESS_TOTAL_MS,
  withDiscoveryReadBudget,
} from "./discoveryBudgets";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import type { readFeedHttp } from "~/server/rss/feedHttp";

const MAX_CANDIDATES = 8;

function scoutFetcher(read: typeof readFeedHttp, strict: boolean) {
  return async (
    targetUrl: string,
    options?: { headers?: Record<string, string>; method?: "GET" | "HEAD" },
  ) => {
    const response = await read(targetUrl, options);
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
  };
}

export async function discoverRssFeeds(
  url: string,
  read: typeof readFeedHttp,
  strict: boolean,
  onFeed?: (feed: DiscoveredFeed) => Promise<void>,
) {
  const fetchFn = scoutFetcher(read, strict);
  const extractFn: typeof defaultExtractFn = async (input) => {
    const result = await defaultExtractFn(input);
    if (result.isValid) await onFeed?.(result);
    return result;
  };
  if (strict)
    return scoutFeeds(url, {
      methods: ["platform", "html", "headers", "guess"],
      concurrency: 2,
      maxUris: MAX_CANDIDATES,
      includeInvalid: true,
      fetchFn,
    });

  const page = await read(url);
  const input = { url: page.url, content: page.text, headers: page.headers };
  const attempted = new Set<string>();
  const advertised = await scoutFeeds(input, {
    methods: ["platform", "html", "headers"],
    concurrency: 2,
    maxUris: MAX_CANDIDATES,
    fetchFn,
    extractFn,
    onProgress: ({ current }) => attempted.add(current),
  });
  const remaining = MAX_CANDIDATES - attempted.size;
  // A direct Feed already resolved; there is no website to probe for alternatives.
  if (remaining <= 0 || advertised.some((feed) => feed.isValid && !feed.method))
    return advertised;

  const uris = discoverUrisFromGuess({
    ...defaultGuessOptions,
    baseUrl: page.url,
  }).flatMap((entry) => {
    const candidates = (typeof entry === "string" ? [entry] : entry).filter(
      (candidate) => !attempted.has(candidate),
    );
    return candidates.length ? [candidates] : [];
  });
  if (!uris.length) return advertised;

  const guesses = await scoutFeeds(input, {
    methods: { guess: { uris } },
    // Streaming probes retain the full read allowance. Start every bounded
    // candidate so slow misses cannot hold a later valid Feed behind them.
    concurrency: onFeed ? MAX_CANDIDATES : 4,
    maxUris: remaining,
    extractFn,
    fetchFn: scoutFetcher(
      onFeed
        ? read
        : withDiscoveryReadBudget(
            read,
            DISCOVERY_GUESS_TOTAL_MS,
            DISCOVERY_GUESS_REQUEST_MS,
          ),
      false,
    ),
  }).catch(() => []);
  return [...advertised, ...guesses];
}
