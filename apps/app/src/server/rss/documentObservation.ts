import {
  buildBlueskyCdnImageUrl,
  buildCanonicalDocumentUrl,
  convertDocumentContent,
  sanitizeEmbeddedHtml,
} from "@serial/standard-site";
import { itemUrl } from "./itemObservation";
import { boundFeedItems } from "./feedBounds";
import type {
  parseDocumentRecord,
  parsePublicationRecord,
} from "@serial/standard-site";
import type { PublicationClient } from "./atprotoClient";
import type { ItemObservation } from "./itemObservation";

/** The same conversion and sanitization for repository reads and stream events. */
export async function documentObservation(
  document: NonNullable<ReturnType<typeof parseDocumentRecord>>,
  publication: NonNullable<ReturnType<typeof parsePublicationRecord>>,
  did: string,
  client: PublicationClient,
): Promise<ItemObservation> {
  const converted = await convertDocumentContent(document.value, {
    did: did,
    loadBlob: client.loadBlob,
    resolveRecord: client.resolveRecord,
  });
  const canonical = buildCanonicalDocumentUrl(
    publication.value.url,
    document.value.path,
  );
  const observation: ItemObservation = {
    kind: "atproto",
    key: document.uri,
    url: itemUrl(canonical ?? document.uri),
    title: document.value.title,
    author:
      document.value.contributors
        ?.map((entry) => entry.displayName?.trim())
        .filter(Boolean)
        .join(", ") ?? "",
    description: document.value.description ?? "",
    thumbnail: document.value.coverImage
      ? (buildBlueskyCdnImageUrl(did, document.value.coverImage.ref.$link) ??
        "")
      : "",
    content: sanitizeEmbeddedHtml(
      boundFeedItems([
        {
          id: document.uri,
          title: "",
          url: document.uri,
          author: "",
          publishedDate: document.value.publishedAt,
          content: converted?.html ?? "",
        },
      ])[0]!.content ?? "",
    ),
    firstParagraph: converted?.firstParagraph ?? "",
    firstImageUrl: converted?.firstImageUrl ?? "",
    publishedAt: document.value.publishedAt,
    tags: document.value.tags ?? [],
    publicationName: publication.value.name,
  };
  return observation;
}
