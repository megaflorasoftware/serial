import { STANDARD_SITE_COLLECTIONS } from "./lexicons";

export type AtUriParts = {
  did: string;
  collection: string;
  rkey: string;
};

// Identifier syntaxes from the AT Protocol specs. Every value that reaches a URL
// path is checked against one of these so a crafted record cannot escape the
// segment it is interpolated into.
const DID_PATTERN =
  /^did:[a-z]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$/;
const NSID_SEGMENT = "[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?";
const NSID_PATTERN = new RegExp(
  `^${NSID_SEGMENT}(?:\\.${NSID_SEGMENT})+\\.[a-zA-Z][a-zA-Z0-9]{0,62}$`,
);
const NSID_MAX_LENGTH = 317;
const RECORD_KEY_PATTERN = /^[A-Za-z0-9._:~-]{1,512}$/;
const CID_PATTERN = /^[A-Za-z0-9]{1,256}$/;
const AT_URI_PATTERN = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;

/** `.` and `..` would traverse the path they are interpolated into. */
function isPathSegment(value: string) {
  return value !== "." && value !== "..";
}

// A DID always starts with `did:`, so it can never be a traversal segment.
export function isDid(value: string) {
  return DID_PATTERN.test(value);
}

export function isNsid(value: string) {
  return value.length <= NSID_MAX_LENGTH && NSID_PATTERN.test(value);
}

export function isRecordKey(value: string) {
  return RECORD_KEY_PATTERN.test(value) && isPathSegment(value);
}

export function isCid(value: string) {
  return CID_PATTERN.test(value);
}

export function parseAtUri(uri: string): AtUriParts | null {
  const match = AT_URI_PATTERN.exec(uri);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const [, did, collection, rkey] = match;
  if (!isDid(did) || !isNsid(collection) || !isRecordKey(rkey)) {
    return null;
  }
  return { did, collection, rkey };
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
  const publication = parsePublicationUri(publicationUri);
  if (!publication) return false;
  if (documentSite === publicationUri) return true;
  const site = parseAtUri(documentSite);
  if (!site) return false;
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
 * The canonical document URL is the publication URL plus the document path,
 * normalised so both origins of a Feed land on one item key: parsed as a URL
 * (collapsing dot segments and percent-encoding the path) with the fragment
 * dropped, matching the RSS side's `normalizeBookmarkUrl`. Query strings and
 * path case survive on both sides, so they stay significant here too.
 *
 * A document without a path, or a publication without a usable URL, has no
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
  let joined: URL;
  try {
    joined = new URL(`${base}${path}`);
  } catch {
    return null;
  }
  joined.hash = "";
  return joined.toString();
}

export const BLUESKY_CDN_ORIGIN = "https://cdn.bsky.app";

export type BlueskyCdnPreset = "feed_fullsize" | "feed_thumbnail" | "avatar";

/** Null when the DID or CID could not sit safely in a URL path segment. */
export function buildBlueskyCdnImageUrl(
  did: string,
  cid: string,
  preset: BlueskyCdnPreset = "feed_fullsize",
): string | null {
  if (!isDid(did) || !isCid(cid)) return null;
  return `${BLUESKY_CDN_ORIGIN}/img/${preset}/plain/${did}/${cid}@jpeg`;
}

export function buildBlueskyProfileUrl(did: string): string | null {
  return isDid(did) ? `https://bsky.app/profile/${did}` : null;
}

export function buildBlueskyPostUrl(postUri: string): string | null {
  const parts = parseAtUri(postUri);
  if (!parts || parts.collection !== "app.bsky.feed.post") return null;
  return `https://bsky.app/profile/${parts.did}/post/${parts.rkey}`;
}

/** Null unless the value is a well-formed at-uri, so nothing else reaches the path. */
export function buildPdslsUrl(atUri: string): string | null {
  return parseAtUri(atUri) ? `https://pdsls.dev/${atUri}` : null;
}
