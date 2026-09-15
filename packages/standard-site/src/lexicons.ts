import { z } from "zod";

export const STANDARD_SITE_COLLECTIONS = {
  publication: "site.standard.publication",
  document: "site.standard.document",
  subscription: "site.standard.graph.subscription",
} as const;

export const STANDARD_SITE_PERMISSION_SETS = {
  social: "site.standard.authSocial",
} as const;

export const STANDARD_SITE_WELL_KNOWN_PATH =
  "/.well-known/site.standard.publication";
export const STANDARD_SITE_LINK_REL = {
  publication: "site.standard.publication",
  document: "site.standard.document",
} as const;

export const BLOCK_NATIVE_CONTENT_TYPES = {
  leaflet: "pub.leaflet.content",
  offprint: "app.offprint.content",
  pckt: "blog.pckt.content",
} as const;

export type BlockNativeContentType =
  (typeof BLOCK_NATIVE_CONTENT_TYPES)[keyof typeof BLOCK_NATIVE_CONTENT_TYPES];

export const blobRefSchema = z.object({
  $type: z.literal("blob").optional(),
  ref: z.object({ $link: z.string() }),
  mimeType: z.string(),
  size: z.number().optional(),
});

export type BlobRef = z.infer<typeof blobRefSchema>;

export const strongRefSchema = z.object({
  uri: z.string(),
  cid: z.string(),
});

export type StrongRef = z.infer<typeof strongRefSchema>;

const contributorSchema = z.object({
  did: z.string(),
  role: z.string().optional(),
  displayName: z.string().optional(),
});

const selfLabelsSchema = z
  .object({ values: z.array(z.object({ val: z.string() })).optional() })
  .passthrough();

export const publicationRecordSchema = z
  .object({
    $type: z.literal(STANDARD_SITE_COLLECTIONS.publication).optional(),
    url: z.string(),
    name: z.string(),
    description: z.string().optional(),
    icon: blobRefSchema.optional(),
    labels: selfLabelsSchema.optional(),
    preferences: z
      .object({ showInDiscover: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type PublicationRecord = z.infer<typeof publicationRecordSchema>;

// The content union is open; the converters narrow it by $type.
const documentContentSchema = z.object({ $type: z.string() }).passthrough();

export const documentRecordSchema = z
  .object({
    $type: z.literal(STANDARD_SITE_COLLECTIONS.document).optional(),
    site: z.string(),
    title: z.string(),
    publishedAt: z.string(),
    path: z.string().optional(),
    description: z.string().optional(),
    content: documentContentSchema.optional(),
    textContent: z.string().optional(),
    coverImage: blobRefSchema.optional(),
    bskyPostRef: strongRefSchema.optional(),
    tags: z.array(z.string()).optional(),
    contributors: z.array(contributorSchema).optional(),
    updatedAt: z.string().optional(),
    labels: selfLabelsSchema.optional(),
  })
  .passthrough();

export type DocumentRecord = z.infer<typeof documentRecordSchema>;
export type DocumentContributor = z.infer<typeof contributorSchema>;

export const subscriptionRecordSchema = z
  .object({
    $type: z.literal(STANDARD_SITE_COLLECTIONS.subscription).optional(),
    publication: z.string(),
    createdAt: z.string().optional(),
  })
  .passthrough();

export type SubscriptionRecord = z.infer<typeof subscriptionRecordSchema>;

export const listedRecordSchema = z.object({
  uri: z.string(),
  cid: z.string(),
  value: z.unknown(),
});

export type ListedRecord<TValue> = {
  uri: string;
  cid: string;
  value: TValue;
};

function parseListedRecord<TValue>(
  input: unknown,
  valueSchema: z.ZodType<TValue>,
): ListedRecord<TValue> | null {
  const listed = listedRecordSchema.safeParse(input);
  if (!listed.success) return null;
  const value = valueSchema.safeParse(listed.data.value);
  if (!value.success) return null;
  return { uri: listed.data.uri, cid: listed.data.cid, value: value.data };
}

export function parsePublicationRecord(input: unknown) {
  return parseListedRecord(input, publicationRecordSchema);
}

export function parseDocumentRecord(input: unknown) {
  return parseListedRecord(input, documentRecordSchema);
}

export function parseSubscriptionRecord(input: unknown) {
  return parseListedRecord(input, subscriptionRecordSchema);
}

export function isBlockNativeContentType(
  type: string | undefined,
): type is BlockNativeContentType {
  return (
    type === BLOCK_NATIVE_CONTENT_TYPES.leaflet ||
    type === BLOCK_NATIVE_CONTENT_TYPES.offprint ||
    type === BLOCK_NATIVE_CONTENT_TYPES.pckt
  );
}

export function isBlockNativeDocument(document: DocumentRecord) {
  return isBlockNativeContentType(document.content?.$type);
}
