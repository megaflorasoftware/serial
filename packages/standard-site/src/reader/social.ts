import { z } from "zod";
import type {
  ReaderBlock,
  ReaderImage,
  ReaderLinkPreview,
  ReaderSocialAuthor,
  ReaderSocialPost,
  ReaderSocialVideo,
} from "./model";
import { facetArraySchema } from "./rich-text";
import { block } from "./context";
import type { AdapterContext } from "./context";
import {
  blobRefSchema,
  parsePublicationRecord,
  strongRefSchema,
} from "../lexicons";
import { recordCard } from "../record-card";
import { publicationPreview, recordPreview } from "../record-preview";
import type { RecordLookup } from "../record-preview";
import {
  buildBlueskyCdnImageUrl,
  buildBlueskyPostUrl,
  buildBlueskyProfileRecordUri,
  buildBlueskyProfileUrl,
  buildBlueskyBlobUrl,
  buildBlueskyVideoPlaylistUrl,
  buildBlueskyVideoThumbnailUrl,
  buildPcktNoteUrl,
  buildPdslsUrl,
  normalizePublicationUrl,
  parseAtUri,
  SOCIAL_POST_COLLECTIONS,
  socialPlatformOf,
} from "../uris";
import { STANDARD_SITE_COLLECTIONS } from "../lexicons";
import { safeLinkUrl } from "../urls";
import { validEntriesSchema } from "../parse";

/**
 * Bluesky posts and pckt notes share one shape: text with facets, a creation
 * time, self labels and an embed that is images, an external link, a quoted
 * record, or a quoted record with media. The card is derived from the raw
 * record and whichever second-hop snapshots have resolved: the author's
 * profile and DID document, and a blog-voiced note's publication.
 */

const MAX_EMBEDDED_IMAGES = 4;

/** Self labels whose media the reader keeps off screen. */
const MEDIA_HIDING_LABELS = new Set([
  "porn",
  "sexual",
  "nudity",
  "graphic-media",
  "gore",
]);

const aspectRatioSchema = z.object({
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});

const imageSchema = z.object({
  image: blobRefSchema,
  alt: z.string().catch(""),
  aspectRatio: aspectRatioSchema.optional().catch(undefined),
});

const externalSchema = z.object({
  uri: z.string(),
  title: z.string().catch(""),
  description: z.string().catch(""),
  thumb: blobRefSchema.optional().catch(undefined),
});

const embedSchema = z.looseObject({
  $type: z.string(),
  images: validEntriesSchema(imageSchema).optional().catch(undefined),
  external: externalSchema.optional().catch(undefined),
  record: z.unknown().optional(),
  media: z.unknown().optional(),
  video: blobRefSchema.optional().catch(undefined),
  alt: z.string().optional().catch(undefined),
  presentation: z.string().optional().catch(undefined),
  captions: validEntriesSchema(
    z.object({ lang: z.string(), file: blobRefSchema }),
  )
    .optional()
    .catch(undefined),
  aspectRatio: aspectRatioSchema.optional().catch(undefined),
});

const selfLabelsSchema = z.looseObject({
  values: validEntriesSchema(z.object({ val: z.string() }))
    .optional()
    .catch(undefined),
});

export const socialPostRecordSchema = z.looseObject({
  text: z.string(),
  facets: facetArraySchema.optional().catch(undefined),
  createdAt: z.string().optional().catch(undefined),
  embed: embedSchema.optional().catch(undefined),
  labels: selfLabelsSchema.optional().catch(undefined),
  /** pckt: the publication a note is voiced as. */
  publication: z.string().optional().catch(undefined),
});

const profileRecordSchema = z.looseObject({
  displayName: z.string().optional().catch(undefined),
  avatar: blobRefSchema.optional().catch(undefined),
});

/** The DID document as the resolver returns it; only the handle is read. */
const didDocumentSchema = z.looseObject({
  alsoKnownAs: validEntriesSchema(z.string()).optional().catch(undefined),
});

const snapshotValueSchema = z.object({ value: z.unknown() });

/** The value of a resolved snapshot parsed by one schema, or null. */
function recordValue<T>(
  lookup: RecordLookup,
  uri: string,
  schema: z.ZodType<T>,
) {
  const listed = snapshotValueSchema.safeParse(lookup(uri));
  if (!listed.success) return null;
  const value = schema.safeParse(listed.data.value);
  return value.success ? value.data : null;
}

/** The handle a DID document names, without its `at://` prefix. */
export function handleFromDidDocument(value: unknown): string | null {
  const document = didDocumentSchema.safeParse(value);
  const known = document.success ? document.data.alsoKnownAs : undefined;
  const handle = known
    ?.find((entry) => entry.startsWith("at://"))
    ?.slice("at://".length);
  return handle && /^[A-Za-z0-9.-]{1,253}$/.test(handle) ? handle : null;
}

function embeddedImages(
  images: z.infer<typeof imageSchema>[] | undefined,
  did: string,
): ReaderImage[] {
  return (images ?? []).slice(0, MAX_EMBEDDED_IMAGES).flatMap((entry) => {
    const url = buildBlueskyCdnImageUrl(did, entry.image.ref.$link);
    return url
      ? [
          {
            url,
            alt: entry.alt,
            title: null,
            aspectRatio: entry.aspectRatio ?? null,
            width: null,
            fullBleed: false,
          },
        ]
      : [];
  });
}

function externalPreview(
  external: z.infer<typeof externalSchema> | undefined,
  did: string,
): ReaderLinkPreview | null {
  const href = safeLinkUrl(external?.uri);
  if (!external || !href) return null;
  return {
    href,
    title: external.title.trim() || href,
    description: external.description.trim() || null,
    imageUrl: external.thumb
      ? buildBlueskyCdnImageUrl(did, external.thumb.ref.$link, "feed_thumbnail")
      : null,
  };
}

/** A labeled post keeps its external link but not the link's thumbnail. */
function withoutHiddenThumb(
  external: ReaderLinkPreview | null,
  mediaHidden: boolean,
) {
  return external && mediaHidden ? { ...external, imageUrl: null } : external;
}

function hidesMedia(labels: z.infer<typeof selfLabelsSchema> | undefined) {
  return (labels?.values ?? []).some((label) =>
    MEDIA_HIDING_LABELS.has(label.val),
  );
}

/** The record a post quotes, from `#record` or the `record` half of `#recordWithMedia`. */
function quotedRecordUri(embed: z.infer<typeof embedSchema> | undefined) {
  if (!embed) return null;
  const direct = strongRefSchema.safeParse(embed.record);
  if (direct.success) return direct.data.uri;
  const nested = z
    .object({ record: strongRefSchema })
    .safeParse(embed.record);
  return nested.success ? nested.data.record.uri : null;
}

/** The media half of a `#recordWithMedia` embed, read like a plain embed. */
function mediaOf(embed: z.infer<typeof embedSchema> | undefined) {
  if (!embed) return undefined;
  if (embed.media === undefined) return embed;
  const media = embedSchema.safeParse(embed.media);
  return media.success ? media.data : undefined;
}

function videoOf(
  media: z.infer<typeof embedSchema>,
  did: string,
): ReaderSocialVideo | null {
  const cid = media.video?.ref.$link;
  if (!cid) return null;
  const thumbnailUrl = buildBlueskyVideoThumbnailUrl(did, cid);
  const playlistUrl = buildBlueskyVideoPlaylistUrl(did, cid);
  if (!thumbnailUrl || !playlistUrl) return null;
  const captions: ReaderSocialVideo["captions"] = [];
  for (const caption of media.captions ?? []) {
    const url = buildBlueskyBlobUrl(did, caption.file.ref.$link);
    if (url) captions.push({ lang: caption.lang, url });
  }
  return {
    thumbnailUrl,
    playlistUrl,
    alt: media.alt?.trim() ?? "",
    aspectRatio: media.aspectRatio ?? null,
    gif: media.presentation === "gif",
    captions,
  };
}

function authorOf(
  did: string,
  publicationUri: string | null,
  records: RecordLookup,
): { author: ReaderSocialAuthor; siteUrl: string | null } {
  const profileUri = buildBlueskyProfileRecordUri(did);
  const profile = profileUri
    ? recordValue(records, profileUri, profileRecordSchema)
    : null;
  // The publication reads exactly as a publication card does; a record the
  // card would reject voices the note as the profile instead.
  const publicationParts = publicationUri ? parseAtUri(publicationUri) : null;
  const publicationRecord = publicationUri
    ? parsePublicationRecord(records(publicationUri))
    : null;
  const publication =
    publicationRecord && publicationParts
      ? publicationPreview(
          publicationRecord,
          publicationParts.did,
          buildPdslsUrl(publicationUri!) ?? publicationUri!,
        )
      : null;
  const handle = handleFromDidDocument(
    snapshotValueSchema.safeParse(records(did)).data?.value,
  );
  const siteUrl = publication
    ? normalizePublicationUrl(publication.url)
    : null;
  const profileUrl = buildBlueskyProfileUrl(did)!;
  const blogName = publication?.title.trim() || null;
  const profileAvatar = profile?.avatar
    ? buildBlueskyCdnImageUrl(did, profile.avatar.ref.$link, "avatar")
    : null;
  return {
    author: {
      did,
      handle,
      name: blogName ?? profile?.displayName?.trim() ?? null,
      avatarUrl: publication?.iconUrl ?? profileAvatar,
      url: siteUrl ?? profileUrl,
    },
    siteUrl,
  };
}

/**
 * One level of quoted record: a social post card without its own quote, or
 * a document card. Nothing further nests. Unresolved quotes stay a link.
 */
function quoteBlock(
  uri: string,
  context: AdapterContext,
): ReaderBlock | null {
  const parts = parseAtUri(uri);
  if (!parts) return null;
  const platform = socialPlatformOf(parts.collection);
  if (platform) {
    const post = socialPost(uri, context, { quoted: true });
    return post ? block(null, { kind: "socialPost", post }) : null;
  }
  if (
    parts.collection !== STANDARD_SITE_COLLECTIONS.document &&
    parts.collection !== STANDARD_SITE_COLLECTIONS.publication
  )
    return null;
  const preview = recordPreview(uri, context.records);
  const card = preview ? recordCard({ ...preview, uri }, "row") : null;
  return card ? block(null, { kind: "recordPreview", card }) : null;
}

/** The page a post lives on, from its URI alone. */
export function socialPostUrl(uri: string) {
  return buildBlueskyPostUrl(uri) ?? buildPcktNoteUrl(uri);
}

/**
 * The card for a resolved post record, or null when the snapshot is absent or
 * not a post. Every second-hop record is asked for through the lookup, so
 * discovery lists them even before they resolve.
 */
export function socialPost(
  uri: string,
  context: AdapterContext,
  options: { quoted?: boolean } = {},
): ReaderSocialPost | null {
  const parts = parseAtUri(uri);
  const platform = parts ? socialPlatformOf(parts.collection) : null;
  const url = socialPostUrl(uri);
  if (!parts || !platform || !url) return null;
  const record = recordValue(context.records, uri, socialPostRecordSchema);
  if (!record) return null;
  const publicationUri =
    platform === "pckt" &&
    record.publication &&
    parseAtUri(record.publication)?.collection ===
      STANDARD_SITE_COLLECTIONS.publication
      ? record.publication
      : null;
  const { author, siteUrl } = authorOf(parts.did, publicationUri, context.records);
  const media = mediaOf(record.embed);
  const mediaHidden = hidesMedia(record.labels);
  const quoted = quotedRecordUri(record.embed);
  const video = media?.video ? videoOf(media, parts.did) : null;
  return {
    platform,
    uri,
    url,
    author,
    siteUrl,
    text: context.richText({
      plaintext: record.text,
      facets: record.facets,
    }),
    createdAt: record.createdAt ?? null,
    images: mediaHidden ? [] : embeddedImages(media?.images, parts.did),
    external: withoutHiddenThumb(
      externalPreview(media?.external, parts.did),
      mediaHidden,
    ),
    video: video && !mediaHidden ? video : null,
    quote: options.quoted || !quoted ? null : quoteBlock(quoted, context),
    mediaHidden,
  };
}

/**
 * Records a post card needs past the post itself: the author's profile and
 * DID document, a blog-voiced note's publication, and one level of quote
 * with that record's own author. Read from resolved snapshots, so each hop
 * is discovered once the previous one is in hand.
 */
export function socialPostReferences(
  uri: string,
  records: RecordLookup,
): string[] {
  const parts = parseAtUri(uri);
  if (!parts || !socialPlatformOf(parts.collection)) return [];
  const record = recordValue(records, uri, socialPostRecordSchema);
  if (!record) return [];
  const references = [buildBlueskyProfileRecordUri(parts.did)!, parts.did];
  if (
    parts.collection === SOCIAL_POST_COLLECTIONS.pckt &&
    record.publication &&
    parseAtUri(record.publication)?.collection ===
      STANDARD_SITE_COLLECTIONS.publication
  )
    references.push(record.publication);
  const quoted = quotedRecordUri(record.embed);
  if (quoted && parseAtUri(quoted)) references.push(quoted);
  return references;
}

