import type { DiscoveredFeed } from "./validation";
export type { DiscoveredFeed, DiscoveredOrigin } from "./validation";
export {
  collapseSyndicationAlternates,
  combinePublicationRows,
  mergeCapturedDiscoveryFeeds,
  matchesDiscoveredFeed,
} from "./grouping";
export type { SyndicationCandidate } from "./grouping";

export const DISCOVERY_LIMIT = 16;
export const DISCOVERY_QUERY_LIMIT = 1024;
export const DISCOVERY_TOTAL_BUDGET_MS = 12_000;

export function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export type DiscoveryOption = DiscoveredFeed & { discoveryId?: string };

export function feedDiscoveryKey(feed: DiscoveryOption): string {
  return (
    feed.discoveryId ??
    feed.origins?.find((origin) => origin.kind === "atproto")?.locator ??
    feed.url
  );
}

export function feedSourceLabel(feed: DiscoveredFeed): string {
  const kinds = new Set(feed.origins?.map((origin) => origin.kind) ?? ["rss"]);
  return kinds.has("rss") && kinds.has("atproto")
    ? "RSS · Atmosphere"
    : kinds.has("atproto")
      ? "Atmosphere"
      : "RSS";
}

export type DiscoveryInput = {
  websiteUrl?: string;
  actorQuery?: string;
  publicationUri?: string;
};

export function classifyDiscoveryInput(value: string): DiscoveryInput | null {
  const input = value.trim();
  if (!input || input.length > DISCOVERY_QUERY_LIMIT) return null;
  if (input.startsWith("at://")) return { publicationUri: input };
  if (input.startsWith("@"))
    return input.length > 1 ? { actorQuery: input.slice(1) } : null;
  if (/^https?:\/\//i.test(input)) {
    const websiteUrl = httpUrl(input);
    if (!websiteUrl) return null;
    const url = new URL(websiteUrl);
    if (url.hostname === "pdsls.dev" && url.pathname.startsWith("/at://")) {
      try {
        return { publicationUri: decodeURIComponent(url.pathname.slice(1)) };
      } catch {
        return null;
      }
    }
    return { websiteUrl };
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return null;
  const websiteUrl = httpUrl(`https://${input}`);
  if (
    websiteUrl &&
    !/\s/.test(input) &&
    new URL(websiteUrl).hostname.includes(".")
  ) {
    const bareDomain = !/[/?#:]/.test(input);
    return { websiteUrl, ...(bareDomain ? { actorQuery: input } : {}) };
  }
  return { actorQuery: input };
}
