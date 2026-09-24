import {
  parseDocumentRecord,
  parsePublicationRecord,
  STANDARD_SITE_COLLECTIONS,
} from "./lexicons";
import type {
  DocumentRecord,
  ListedRecord,
  PublicationRecord,
} from "./lexicons";
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

/** Records already in hand, keyed by URI: Reference snapshots or an import batch. */
export type RecordLookup = (uri: string) => unknown;

/** The publication a document names, normalized from the legacy Leaflet collection. */
export function documentPublicationUri(document: Pick<DocumentRecord, "site">) {
  const site = document.site.replace(
    "/pub.leaflet.publication/",
    `/${STANDARD_SITE_COLLECTIONS.publication}/`,
  );
  const parts = parseAtUri(site);
  return parts?.collection === STANDARD_SITE_COLLECTIONS.publication
    ? site
    : null;
}

/**
 * A publication as a card: its site, name, description and icon. Also how a
 * blog-voiced social post reads the publication it speaks as.
 */
export function publicationPreview(
  publication: ListedRecord<PublicationRecord>,
  did: string,
  fallback: string,
): RecordPreview {
  return {
    url: normalizePublicationUrl(publication.value.url) ?? fallback,
    title: publication.value.name,
    description: publication.value.description,
    iconUrl: publication.value.icon
      ? (buildBlueskyCdnImageUrl(
          did,
          publication.value.icon.ref.$link,
          "avatar",
        ) ?? undefined)
      : undefined,
  };
}

/**
 * Derives card metadata from records already resolved. A document's publication
 * is read through the same lookup; its absence keeps the document's own fields.
 */
export function recordPreview(
  uri: string,
  records: RecordLookup,
): RecordPreview | null {
  const parts = parseAtUri(uri);
  const fallback = buildPdslsUrl(uri);
  if (!parts || !fallback) return null;
  const record = records(uri);
  if (record === undefined || record === null) return null;
  if (parts.collection === STANDARD_SITE_COLLECTIONS.publication) {
    const publication = parsePublicationRecord(record);
    return publication
      ? publicationPreview(publication, parts.did, fallback)
      : null;
  }
  if (parts.collection !== STANDARD_SITE_COLLECTIONS.document) return null;
  const document = parseDocumentRecord(record);
  if (!document) return null;
  const value = document.value;
  const site = documentPublicationUri(value);
  const publication = site ? parsePublicationRecord(records(site)) : null;
  const publicationDid = site ? parseAtUri(site)?.did : undefined;
  return {
    url:
      buildCanonicalDocumentUrl(
        publication?.value.url ?? value.site,
        value.path,
      ) ?? fallback,
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
