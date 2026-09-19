import { parseAtUri } from "./uris";
import { z } from "zod";
import { element, linkCard, safeSourceUrl } from "./convert/html";
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

/** One contract for conversion, sanitization, and trusted reader reconstruction. */
export const RECORD_CARD_FIELDS = {
  uri: "data-record-uri",
  url: "data-href",
  title: "data-title",
  description: "data-description",
  imageUrl: "data-image-url",
  publicationName: "data-publication-name",
  iconUrl: "data-icon-url",
  author: "data-author",
  publishedAt: "data-published-at",
  size: "data-size",
} as const;

export function parseRecordCard(attributes: Record<string, string>) {
  const parsed = recordCardSchema.safeParse(
    Object.fromEntries(
      Object.entries(RECORD_CARD_FIELDS).map(([field, attribute]) => [
        field,
        attributes[attribute],
      ]),
    ),
  );
  return parsed.success ? parsed.data : null;
}

export function recordCard(
  preview: RecordPreview & { uri: string },
  size: unknown = "row",
) {
  const parsed = recordCardSchema.safeParse({ ...preview, size });
  if (!parsed.success) return "";
  const card = parsed.data;
  return element(
    "div",
    {
      "data-serial-embed": "record",
      ...Object.fromEntries(
        Object.entries(RECORD_CARD_FIELDS).map(([field, attribute]) => [
          attribute,
          card[field as keyof RecordCard],
        ]),
      ),
    },
    linkCard({
      href: card.url,
      title: card.title,
      description: card.description,
    }),
  );
}
