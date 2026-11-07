import type { DiscoveredFeed } from "./index";

export type SyndicationCandidate = {
  row: DiscoveredFeed;
  hasFullBody: boolean;
  itemUrls: string[];
};

function siteKey(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function staysSeparate(candidate: SyndicationCandidate) {
  return /(?:^|[\s/_.?=&-])(comments?|podcasts?|tags?|categor(?:y|ies)|authors?)(?:$|[\s/_.?=&-])/i.test(
    `${candidate.row.url} ${candidate.row.title ?? ""}`,
  );
}

function sameFeed(left: SyndicationCandidate, right: SyndicationCandidate) {
  const site = siteKey(left.row.siteUrl);
  const sameSite = site && site === siteKey(right.row.siteUrl);
  if (site && siteKey(right.row.siteUrl) && !sameSite) return false;
  if (left.row.format === right.row.format) return false;
  const urls = new Set(left.itemUrls);
  const rightUrls = new Set(right.itemUrls);
  const sameItems =
    urls.size >= 2 &&
    urls.size === rightUrls.size &&
    [...rightUrls].every((url) => urls.has(url));
  return (
    sameItems ||
    (Boolean(sameSite) &&
      Boolean(left.row.title) &&
      left.row.title === right.row.title) ||
    (!site &&
      !right.row.siteUrl &&
      Boolean(left.row.title) &&
      left.row.title === right.row.title)
  );
}

function rank(candidate: SyndicationCandidate) {
  const format = candidate.row.format?.toLowerCase();
  return (
    (candidate.hasFullBody ? 0 : 10) +
    (format === "atom" ? 0 : format === "json" ? 1 : 2)
  );
}

export function collapseSyndicationAlternates(
  candidates: SyndicationCandidate[],
  pastedUrl?: string,
): DiscoveredFeed[] {
  if (
    pastedUrl &&
    candidates.some((candidate) => candidate.row.url === pastedUrl)
  ) {
    return candidates
      .filter((candidate) => candidate.row.url === pastedUrl)
      .map((candidate) => candidate.row);
  }
  const groups: SyndicationCandidate[][] = [];
  for (const candidate of candidates) {
    const group =
      !staysSeparate(candidate) &&
      groups.find(
        (entries) =>
          !staysSeparate(entries[0]!) && sameFeed(entries[0]!, candidate),
      );
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  return groups.map((group) => {
    const sorted = [...group].sort((left, right) => rank(left) - rank(right));
    const chosen = sorted[0]!.row;
    return {
      ...chosen,
      origins: [
        {
          kind: "rss" as const,
          locator: chosen.url,
          format: chosen.format,
          alternateUrls: sorted.slice(1).map((candidate) => candidate.row.url),
        },
      ],
    };
  });
}

/** Website results keep their order. A publication is represented at most once. */
export function combinePublicationRows(
  websites: DiscoveredFeed[],
  publications: DiscoveredFeed[],
): DiscoveredFeed[] {
  const result = [...websites];
  const seen = new Set(
    websites.flatMap(
      (row) =>
        row.origins
          ?.filter((origin) => origin.kind === "atproto")
          .map((origin) => origin.locator) ?? [],
    ),
  );
  for (const publication of publications) {
    const origin = publication.origins?.find(
      (source) => source.kind === "atproto",
    );
    if (!origin || seen.has(origin.locator)) continue;
    seen.add(origin.locator);
    const site = siteKey(publication.siteUrl);
    const index = result.findIndex(
      (row) =>
        site &&
        siteKey(row.siteUrl) === site &&
        !row.origins?.some((source) => source.kind === "atproto") &&
        !staysSeparate({ row, hasFullBody: false, itemUrls: [] }),
    );
    if (index < 0) result.push(publication);
    else {
      const rss = result[index]!;
      result[index] = {
        ...rss,
        title: publication.title || rss.title,
        imageUrl: publication.imageUrl ?? rss.imageUrl,
        origins: [
          ...(rss.origins ?? [{ kind: "rss", locator: rss.url }]),
          origin,
        ],
      };
    }
  }
  return result;
}

function rssLocators(feed: DiscoveredFeed) {
  const locators = new Set<string>();
  for (const origin of feed.origins ?? []) {
    if (origin.kind !== "rss") continue;
    locators.add(origin.locator);
    for (const alternate of origin.alternateUrls ?? []) locators.add(alternate);
  }
  if (!feed.origins) locators.add(feed.url);
  return locators;
}

function sharesRssLocator(left: DiscoveredFeed, right: DiscoveredFeed) {
  const rightLocators = rssLocators(right);
  return [...rssLocators(left)].some((locator) => rightLocators.has(locator));
}

function atprotoLocator(feed: DiscoveredFeed) {
  return feed.origins?.find((origin) => origin.kind === "atproto")?.locator;
}

export function matchesDiscoveredFeed(
  left: DiscoveredFeed,
  right: DiscoveredFeed,
) {
  const leftAtproto = atprotoLocator(left);
  return (
    sharesRssLocator(left, right) ||
    (leftAtproto !== undefined && leftAtproto === atprotoLocator(right))
  );
}

/** Keep browser-discovered RSS rows that a remote discovery response could not see. */
export function mergeCapturedDiscoveryFeeds(
  captured: DiscoveredFeed[],
  remote: DiscoveredFeed[],
  limit: number,
) {
  const merged: DiscoveredFeed[] = [];
  const remoteWebsite = remote.filter((feed) => rssLocators(feed).size > 0);
  const remoteAtmosphere = remote.filter(
    (feed) => rssLocators(feed).size === 0,
  );
  for (const feed of [...remoteWebsite, ...captured, ...remoteAtmosphere]) {
    if (merged.some((existing) => matchesDiscoveredFeed(existing, feed)))
      continue;
    merged.push(feed);
    if (merged.length >= limit) break;
  }
  return merged;
}
