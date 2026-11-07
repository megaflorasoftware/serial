import { buildPdslsUrl, parseAtUri } from "./uris";
import { z } from "zod";
import { safeSourceUrl } from "./urls";
import type { RecordPreview } from "./record-preview";

export const RECORD_CARD_SIZES = ["small", "medium", "large", "row"] as const;
const safeUrl = z
  .string()
  .transform((value) => safeSourceUrl(value))
  .pipe(z.string());
const optionalText = z.string().max(10_000).optional().catch(undefined);
const optionalUrl = safeUrl.optional().catch(undefined);
export const recordCardSchema = z.object({
  uri: z.string().refine((value) => parseAtUri(value) !== null),
  url: safeUrl,
  title: z.string().max(10_000),
  description: optionalText,
  imageUrl: optionalUrl,
  publicationName: optionalText,
  iconUrl: optionalUrl,
  author: optionalText,
  publishedAt: optionalText,
  size: z.enum(RECORD_CARD_SIZES).catch("row"),
});
export type RecordCard = z.infer<typeof recordCardSchema>;

/**
 * The card a Record preview draws: validated metadata, or the record inspector
 * fallback when the preview is malformed. Null only when the URI itself is
 * unusable.
 */
export function recordCard(
  preview: RecordPreview & { uri: string },
  size: unknown = "row",
): RecordCard | null {
  const parsed = recordCardSchema.safeParse({ ...preview, size });
  if (parsed.success) return parsed.data;
  const fallback = buildPdslsUrl(preview.uri);
  if (!fallback) return null;
  return {
    uri: preview.uri,
    url: fallback,
    title: "Embedded record",
    description: preview.uri,
    size: "row",
  };
}
