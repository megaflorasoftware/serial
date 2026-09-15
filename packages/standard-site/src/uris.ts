import { STANDARD_SITE_COLLECTIONS } from "./lexicons";

export type AtUriParts = {
  did: string;
  collection: string;
  rkey: string;
};

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const AT_URI_PATTERN =
  /^at:\/\/(did:[a-z0-9]+:[A-Za-z0-9._:%-]+)\/([^/]+)\/([^/?#]+)$/;

export function isDid(value: string) {
  return DID_PATTERN.test(value);
}

export function parseAtUri(uri: string): AtUriParts | null {
  const match = AT_URI_PATTERN.exec(uri);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { did: match[1], collection: match[2], rkey: match[3] };
}

export function buildAtUri(parts: AtUriParts) {
  return `at://${parts.did}/${parts.collection}/${parts.rkey}`;
}

export function parsePublicationUri(uri: string): AtUriParts | null {
  const parts = parseAtUri(uri);
  if (!parts || parts.collection !== STANDARD_SITE_COLLECTIONS.publication) {
    return null;
  }
  return parts;
}

export function parseDocumentUri(uri: string): AtUriParts | null {
  const parts = parseAtUri(uri);
  if (!parts || parts.collection !== STANDARD_SITE_COLLECTIONS.document) {
    return null;
  }
  return parts;
}

// Leaflet documents published before the standard.site cutover point `site` at the
// legacy `pub.leaflet.publication` record, which shares its rkey with the
// `site.standard.publication` record in the same repo.
const LEGACY_LEAFLET_PUBLICATION_COLLECTION = "pub.leaflet.publication";

export function documentBelongsToPublication(
  documentSite: string,
  publicationUri: string,
) {
  if (documentSite === publicationUri) return true;
  const site = parseAtUri(documentSite);
  const publication = parsePublicationUri(publicationUri);
  if (!site || !publication) return false;
  return (
    site.collection === LEGACY_LEAFLET_PUBLICATION_COLLECTION &&
    site.did === publication.did &&
    site.rkey === publication.rkey
  );
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

/** Null when the publication URL is not an absolute http(s) URL. */
export function normalizePublicationUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.hash = "";
  parsed.search = "";
  return trimTrailingSlashes(parsed.toString());
}

/**
 * The canonical document URL is the publication URL plus the document path. A
 * document without a path, or a publication without a usable URL, has no
 * canonical URL; callers fall back to the RSS link or the at-uri.
 */
export function buildCanonicalDocumentUrl(
  publicationUrl: string,
  documentPath: string | undefined,
): string | null {
  if (!documentPath) return null;
  const base = normalizePublicationUrl(publicationUrl);
  if (!base) return null;
  const path = documentPath.startsWith("/") ? documentPath : `/${documentPath}`;
  return `${base}${path}`;
}

export const BLUESKY_CDN_ORIGIN = "https://cdn.bsky.app";

export type BlueskyCdnPreset = "feed_fullsize" | "feed_thumbnail" | "avatar";

export function buildBlueskyCdnImageUrl(
  did: string,
  cid: string,
  preset: BlueskyCdnPreset = "feed_fullsize",
) {
  return `${BLUESKY_CDN_ORIGIN}/img/${preset}/plain/${did}/${cid}@jpeg`;
}

export function buildBlueskyProfileUrl(didOrHandle: string) {
  return `https://bsky.app/profile/${didOrHandle}`;
}

export function buildBlueskyPostUrl(postUri: string): string | null {
  const parts = parseAtUri(postUri);
  if (!parts || parts.collection !== "app.bsky.feed.post") return null;
  return `https://bsky.app/profile/${parts.did}/post/${parts.rkey}`;
}

export function buildPdslsUrl(atUri: string) {
  return `https://pdsls.dev/${atUri}`;
}
