import {
  buildCanonicalDocumentUrl,
  documentBelongsToPublication,
  parseDocumentRecord,
  parseDocumentUri,
} from "@serial/standard-site";
import { FEED_HTTP_MAX_BODY_BYTES } from "@serial/bookmark-capture";
import {
  publicationOrigin,
  PublicationUnavailableError,
  resolvePublication,
} from "./publications";
import type { NewFeedOriginDetails } from "~/server/rss/types";
import { createPublicationClient } from "~/server/rss/atprotoClient";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { parseSyndicationFeed } from "~/server/rss/syndication";
import { itemUrl } from "~/server/rss/itemObservation";
import { newRssFeedDetails } from "~/server/rss/types";

export const REVALIDATION_MAX_CANDIDATES = 4;
export const REVALIDATION_DOCUMENT_PAGES = 2;
export const REVALIDATION_ITEM_LIMIT = 200;

export type OriginEvidence = {
  origin: NewFeedOriginDetails;
  siteUrl?: string;
  itemUrls: Set<string>;
};

function articleUrls(urls: string[]) {
  return new Set(
    urls.flatMap((url) => {
      try {
        return [itemUrl(url)];
      } catch {
        return [];
      }
    }),
  );
}

/** Read identities and source metadata only; never convert or ingest article bodies. */
export async function readOriginEvidence(
  origin: Pick<NewFeedOriginDetails, "kind" | "locator" | "alternateLocators">,
  includeItems = true,
): Promise<OriginEvidence> {
  if (origin.kind === "rss") {
    const response = await readFeedHttp(origin.locator, {
      maxBodyBytes: FEED_HTTP_MAX_BODY_BYTES,
      totalDurationMs: 5_000,
    });
    if (!response.ok) throw new Error("Unable to read the RSS Feed");
    const parsed = parseSyndicationFeed(response.text, response.url);
    return {
      origin: {
        ...newRssFeedDetails({
          url: origin.locator,
          platform: "website",
          name: parsed.title,
          imageUrl: parsed.imageUrl,
          description: parsed.description,
          siteUrl: parsed.siteUrl,
        }).origins[0]!,
        alternateLocators: origin.alternateLocators,
      },
      siteUrl: parsed.siteUrl,
      itemUrls: articleUrls(
        includeItems
          ? parsed.items
              .slice(0, REVALIDATION_ITEM_LIMIT)
              .map((item) => item.url)
          : [],
      ),
    };
  }
  const publication = await resolvePublication(origin.locator);
  if (!publication)
    throw new PublicationUnavailableError("Unable to read the publication");
  const urls: string[] = [];
  if (includeItems) {
    const client = createPublicationClient();
    let cursor: string | undefined;
    for (let page = 0; page < REVALIDATION_DOCUMENT_PAGES; page++) {
      const result = await client.list(publication.did, cursor);
      for (const record of result.records) {
        const document = parseDocumentRecord(record);
        if (
          !document ||
          parseDocumentUri(document.uri)?.did !== publication.did ||
          !documentBelongsToPublication(document.value.site, publication.uri)
        )
          continue;
        const url = buildCanonicalDocumentUrl(
          publication.siteUrl,
          document.value.path,
        );
        if (url) urls.push(url);
      }
      if (!result.cursor || result.cursor === cursor) break;
      cursor = result.cursor;
    }
  }
  return {
    origin: publicationOrigin(publication),
    siteUrl: publication.siteUrl,
    itemUrls: articleUrls(urls),
  };
}

export function originsShareArticles(
  left: OriginEvidence,
  right: OriginEvidence,
) {
  return [...left.itemUrls].some((url) => right.itemUrls.has(url));
}
