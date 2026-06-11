import { TID } from "@atproto/common-web";
import type { Release } from "content-collections";

export const STANDARD_SITE = {
  documentCollection: "site.standard.document",
  publicationCollection: "site.standard.publication",
  publicationDescription:
    "Release notes and product updates for Serial, a calm and customizable RSS reader.",
  publicationName: "Serial Releases",
  publicationUrl: "https://serial.tube/releases",
  releaseTags: ["release"],
} as const;

function hashString(value: string) {
  let hash = 2166136261;

  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

export function getReleaseDocumentRkey(
  release: Pick<Release, "publish_date" | "slug">,
) {
  const slugHash = hashString(release.slug);
  const publishedAtMilliseconds = Date.parse(
    `${release.publish_date}T00:00:00.000Z`,
  );
  const timestampMicroseconds =
    publishedAtMilliseconds * 1000 + (slugHash % 1_000_000);

  return TID.fromTime(timestampMicroseconds, slugHash % 1024).toString();
}

export function parsePublicationUri(publicationUri: string) {
  const match = publicationUri.match(
    /^at:\/\/(did:[^/]+)\/site\.standard\.publication\/([234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12})$/,
  );

  if (!match?.[1] || !match[2]) {
    throw new Error(
      "The Standard.Site publication URI must reference a site.standard.publication record with a TID record key.",
    );
  }

  return {
    did: match[1],
    rkey: match[2],
  };
}

export function buildDocumentUri(
  publicationUri: string,
  release: Pick<Release, "publish_date" | "slug">,
) {
  const { did } = parsePublicationUri(publicationUri);
  return `at://${did}/${STANDARD_SITE.documentCollection}/${getReleaseDocumentRkey(release)}`;
}

export function getConfiguredPublicationUri(options: {
  isMainInstance: boolean;
  publicationUri?: string;
}) {
  if (!options.isMainInstance || !options.publicationUri) return undefined;
  parsePublicationUri(options.publicationUri);
  return options.publicationUri;
}

export function buildDocumentLink(
  release: Pick<Release, "publish_date" | "slug">,
  options: {
    isMainInstance: boolean;
    publicationUri?: string;
  },
) {
  const publicationUri = getConfiguredPublicationUri(options);
  if (!publicationUri) return undefined;

  return {
    rel: STANDARD_SITE.documentCollection,
    href: buildDocumentUri(publicationUri, release),
  };
}

export function buildPublicationLink(options: {
  isMainInstance: boolean;
  publicationUri?: string;
}) {
  const publicationUri = getConfiguredPublicationUri(options);
  if (!publicationUri) return undefined;

  return {
    rel: STANDARD_SITE.publicationCollection,
    href: publicationUri,
  };
}

export function createPublicationVerificationResponse(options: {
  isMainInstance: boolean;
  publicationUri?: string;
}) {
  const publicationUri = getConfiguredPublicationUri(options);

  if (!publicationUri) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(publicationUri, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
