import { discoverFeeds as scoutFeeds } from "feedscout";
import {
  defaultExtractFn,
  defaultGuessOptions,
  defaultHtmlOptions,
} from "feedscout/feeds";
import { discoverUrisFromGuess, discoverUrisFromHtml } from "feedscout/methods";
import {
  DISCOVERY_GUESS_REQUEST_MS,
  DISCOVERY_GUESS_TOTAL_MS,
  withDiscoveryReadBudget,
} from "./discoveryBudgets";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import type { readFeedHttp } from "~/server/rss/feedHttp";

const MAX_CANDIDATES = 8;
type RssDiscoveryResult = Awaited<ReturnType<typeof scoutFeeds>>[number] & {
  explicitlyAdvertised?: boolean;
};
type Page = Awaited<ReturnType<typeof readFeedHttp>>;
type OnProgress = (progress: { current: string }) => void;

/** How strict discovery guesses feed addresses the website does not advertise. */
export type FeedGuessing = {
  /** Reads the guessed addresses. Without it, guesses use discovery's reader. */
  read?: typeof readFeedHttp;
  /** Whether a validated advertised Feed makes guessing unnecessary. */
  suffices?: (feed: DiscoveredFeed) => boolean;
};

function requestUrl(uri: string, base: string) {
  const url = URL.parse(uri, base);
  if (!url) return null;
  url.hash = "";
  return url.href;
}

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

/** Advertised candidates, invalid ones included, with anchor links marked as not explicitly advertised. */
async function strictAdvertisedFeeds(
  page: Page,
  read: typeof readFeedHttp,
  onProgress: OnProgress,
): Promise<RssDiscoveryResult[]> {
  const fetchFn = scoutFetcher(read, true);
  const explicitHtml = new Set(
    discoverUrisFromHtml(page.text, {
      ...defaultHtmlOptions,
      baseUrl: page.url,
      anchorUris: [],
      anchorPathSegments: [],
      anchorLabels: [],
      anchorAttributes: [],
    }).flatMap((uri) => {
      const target = requestUrl(uri, page.url);
      return target ? [target] : [];
    }),
  );
  const feeds = await scoutFeeds(
    { url: page.url, content: page.text, headers: page.headers },
    {
      methods: ["platform", "html", "headers"],
      concurrency: 2,
      maxUris: MAX_CANDIDATES,
      includeInvalid: true,
      onProgress,
      fetchFn: async (target, options) => {
        const response = await fetchFn(target, options);
        const requested = requestUrl(target, page.url);
        const resolved = requestUrl(response.url, page.url);
        // The extractor reports the final response URL after redirects.
        if (requested && resolved && explicitHtml.has(requested))
          explicitHtml.add(resolved);
        return response;
      },
    },
  );
  return feeds.map((feed) => ({
    ...feed,
    explicitlyAdvertised:
      feed.method === "html"
        ? explicitHtml.has(requestUrl(feed.url, page.url) ?? "")
        : undefined,
  }));
}

/** Guessed addresses the advertised candidates did not already try. */
function untriedGuesses(baseUrl: string, attempted: Set<string>) {
  return discoverUrisFromGuess({
    ...defaultGuessOptions,
    baseUrl,
  }).flatMap((entry) => {
    const candidates = (typeof entry === "string" ? [entry] : entry).filter(
      (candidate) => !attempted.has(candidate),
    );
    return candidates.length ? [candidates] : [];
  });
}

export async function discoverRssFeeds(
  url: string,
  read: typeof readFeedHttp,
  strict: boolean,
  onFeed?: (feed: DiscoveredFeed) => Promise<void>,
  guessing: FeedGuessing = {},
): Promise<RssDiscoveryResult[]> {
  const extractFn: typeof defaultExtractFn = async (input) => {
    const result = await defaultExtractFn(input);
    if (result.isValid) await onFeed?.(result);
    return result;
  };
  const page = await read(url);
  const input = { url: page.url, content: page.text, headers: page.headers };
  const attempted = new Set<string>();
  const onProgress: OnProgress = ({ current }) => attempted.add(current);
  const advertised: RssDiscoveryResult[] = strict
    ? await strictAdvertisedFeeds(page, read, onProgress)
    : await scoutFeeds(input, {
        methods: ["platform", "html", "headers"],
        concurrency: 2,
        maxUris: MAX_CANDIDATES,
        fetchFn: scoutFetcher(read, false),
        extractFn,
        onProgress,
      });
  const remaining = MAX_CANDIDATES - attempted.size;
  // A direct Feed already resolved; there is no website to probe for alternatives.
  const direct = advertised.some((feed) => feed.isValid && !feed.method);
  const sufficient = advertised.some(
    (feed) =>
      feed.isValid &&
      feed.explicitlyAdvertised !== false &&
      guessing.suffices?.(feed),
  );
  if (remaining <= 0 || direct || sufficient) return advertised;

  const uris = untriedGuesses(page.url, attempted);
  if (!uris.length) return advertised;

  if (strict) {
    const guesses = await scoutFeeds(input, {
      methods: { guess: { uris } },
      concurrency: 2,
      maxUris: remaining,
      includeInvalid: true,
      fetchFn: scoutFetcher(guessing.read ?? read, true),
    });
    return [...advertised, ...guesses];
  }
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
