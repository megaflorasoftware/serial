import { parseDocumentRecord, parsePublicationRecord } from "./lexicons";
import {
  buildBlueskyCdnImageUrl,
  buildCanonicalDocumentUrl,
  buildPdslsUrl,
  normalizePublicationUrl,
  parseAtUri,
} from "./uris";

export type RecordPreview = {
  url: string;
  title: string;
  description?: string;
  imageUrl?: string;
  publicationName?: string;
  iconUrl?: string;
  author?: string;
  publishedAt?: string;
};

/** Shared metadata extraction. The caller supplies its cached Slingshot/PDS reader. */
export async function resolveRecordPreview(
  uri: string,
  readRecord: (uri: string) => Promise<unknown>,
): Promise<RecordPreview | null> {
  const parts = parseAtUri(uri);
  const fallback = buildPdslsUrl(uri);
  if (!parts || !fallback) return null;
  const record = await readRecord(uri);
  if (parts.collection === "site.standard.publication") {
    const publication = parsePublicationRecord(record);
    if (!publication) return null;
    return {
      url: normalizePublicationUrl(publication.value.url) ?? fallback,
      title: publication.value.name,
      description: publication.value.description,
      iconUrl: publication.value.icon
        ? (buildBlueskyCdnImageUrl(
            parts.did,
            publication.value.icon.ref.$link,
            "avatar",
          ) ?? undefined)
        : undefined,
    };
  }
  if (parts.collection !== "site.standard.document") return null;
  const document = parseDocumentRecord(record);
  if (!document) return null;
  const value = document.value;
  const site = value.site.replace(
    "/pub.leaflet.publication/",
    "/site.standard.publication/",
  );
  // Publication failure must not discard the document's own preview metadata.
  const publication =
    parseAtUri(site)?.collection === "site.standard.publication"
      ? parsePublicationRecord(await readRecord(site).catch(() => null))
      : null;
  const publicationDid = parseAtUri(site)?.did;
  return {
    url:
      (publication &&
        buildCanonicalDocumentUrl(publication.value.url, value.path)) ||
      fallback,
    title: value.title,
    description: value.description,
    imageUrl: value.coverImage
      ? (buildBlueskyCdnImageUrl(parts.did, value.coverImage.ref.$link) ??
        undefined)
      : undefined,
    publicationName: publication?.value.name,
    iconUrl:
      publication?.value.icon && publicationDid
        ? (buildBlueskyCdnImageUrl(
            publicationDid,
            publication.value.icon.ref.$link,
            "avatar",
          ) ?? undefined)
        : undefined,
    author:
      value.contributors
        ?.map((contributor) => contributor.displayName?.trim())
        .filter(Boolean)
        .join(", ") || undefined,
    publishedAt: value.publishedAt,
  };
}
