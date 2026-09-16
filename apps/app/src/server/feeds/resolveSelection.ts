import { discoveredFeedSchema } from "@serial/feed-discovery/validation";
import { combinePublicationRows } from "@serial/feed-discovery";
import { normalizePublicationUrl } from "@serial/standard-site";
import { discoverFeeds } from "./discovery";
import { publicationRow, resolvePublication } from "./publications";
import type { DiscoveredFeed } from "@serial/feed-discovery";
import type { NewFeedDetails } from "~/server/rss/types";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";

function isCombinedSelection(
  rssDetails: NewFeedDetails,
  publication: NonNullable<Awaited<ReturnType<typeof resolvePublication>>>,
) {
  const rss = rssDetails.origins.find((origin) => origin.kind === "rss");
  if (!rss) return false;
  const [combined] = combinePublicationRows(
    [
      {
        url: rss.locator,
        title: rssDetails.name,
        siteUrl: rssDetails.siteUrl ?? undefined,
        imageUrl: rssDetails.imageUrl ?? undefined,
        origins: [{ kind: "rss", locator: rss.locator }],
      },
    ],
    [publicationRow(publication)],
  );
  return combined?.origins?.some(
    (origin) => origin.kind === "atproto" && origin.locator === publication.uri,
  );
}

/** Selected rows are hints. Names, PDS endpoints, and origin associations come from fresh server reads. */
export async function resolveFeedSelection(
  userId: string,
  url: string,
  selection?: DiscoveredFeed,
): Promise<NewFeedDetails[]> {
  if (!selection?.origins) {
    const rss = await fetchNewFeedDetails(url);
    if (rss.length) return rss;
    // Old extension installs post only the HTTP URL shown by discovery.
    const discovered = await discoverFeeds(userId, url);
    const row = discovered.find(
      (candidate) =>
        candidate.url === url ||
        candidate.siteUrl === url ||
        normalizePublicationUrl(candidate.siteUrl ?? candidate.url) ===
          normalizePublicationUrl(url),
    );
    if (!row?.origins) return [];
    return resolveFeedSelection(userId, url, row);
  }
  const selected = discoveredFeedSchema.parse(selection);
  let rss = selected.origins?.find((origin) => origin.kind === "rss");
  let publicationDiscovery: DiscoveredFeed[] | undefined;
  const atmosphere = selected.origins?.find(
    (origin) => origin.kind === "atproto",
  );
  const publication = atmosphere
    ? await resolvePublication(atmosphere.locator)
    : null;
  if (atmosphere && !publication)
    throw new Error("Unable to read the selected publication");
  if (publication && !rss) {
    publicationDiscovery = await discoverFeeds(userId, publication.siteUrl);
    const matching = publicationDiscovery.find((row) =>
      row.origins?.some(
        (origin) =>
          origin.kind === "atproto" && origin.locator === publication.uri,
      ),
    );
    rss = matching?.origins?.find((origin) => origin.kind === "rss");
  }
  const rssDetails = rss
    ? (await fetchNewFeedDetails(rss.locator))[0]
    : undefined;
  if (rss && !rssDetails)
    throw new Error("Unable to read the selected RSS Feed");
  if (rssDetails && rss?.alternateUrls?.length) {
    // Rediscover under the shared request/body budget instead of fetching each
    // client-provided alternate with the full ingestion budget.
    const rows =
      publicationDiscovery ??
      (await discoverFeeds(userId, rssDetails.siteUrl ?? rss.locator));
    const verified = rows
      .flatMap((row) => row.origins ?? [])
      .find(
        (origin) =>
          origin.kind === "rss" &&
          (origin.locator === rss.locator ||
            origin.alternateUrls?.includes(rss.locator)),
      );
    const alternateLocators =
      verified?.kind === "rss"
        ? [
            ...new Set([verified.locator, ...(verified.alternateUrls ?? [])]),
          ].filter((locator) => locator !== rss.locator)
        : [];
    rssDetails.origins = rssDetails.origins.map((origin) => ({
      ...origin,
      alternateLocators,
    }));
  }
  if (!publication) return rssDetails ? [rssDetails] : [];
  if (rssDetails && !isCombinedSelection(rssDetails, publication))
    throw new Error("The RSS Feed and publication cannot be combined");
  return [
    {
      ...(rssDetails ?? {}),
      name: publication.name,
      imageUrl: publication.imageUrl ?? rssDetails?.imageUrl,
      platform: rssDetails?.platform ?? "website",
      siteUrl: publication.siteUrl,
      origins: [
        ...(rssDetails?.origins ?? []),
        {
          kind: "atproto",
          locator: publication.uri,
          publicationDid: publication.did,
          publicationRkey: publication.rkey,
          pdsUrl: publication.pdsUrl,
          sourceName: publication.name,
          sourceImageUrl: publication.imageUrl,
          sourceDescription: publication.description,
        },
      ],
    },
  ];
}
