import { z } from "zod";

/**
 * The Reader body contract shared by the server, the browser and offline
 * storage. A body is either HTML (RSS and legacy bodies) or a Document source
 * with the Reference snapshots the reader needs to derive the Reader document.
 */

/** Record text plus fetched overflow blobs, per document. Over budget retains nothing. */
export const DOCUMENT_SOURCE_BUDGET_BYTES = 4 * 1024 * 1024;

/** One body response stops adding items past this many bytes, in request order. */
export const READER_BODY_RESPONSE_BUDGET_BYTES = 4 * 1024 * 1024;

/** A snapshot younger than this is not refreshed when a document opens. */
export const REFERENCE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** Missing and unsupported records are not looked up again before this. */
export const REFERENCE_MISSING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Import reuses a snapshot younger than this instead of resolving again. */
export const REFERENCE_IMPORT_REUSE_MS = 24 * 60 * 60 * 1000;

/** Snapshots unread for this long are deleted. */
export const REFERENCE_UNREAD_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const REFERENCE_SNAPSHOT_OUTCOMES = [
  "resolved",
  "missing",
  "unsupported",
  "unavailable",
] as const;
export type ReferenceSnapshotOutcome =
  (typeof REFERENCE_SNAPSHOT_OUTCOMES)[number];

export const documentSourceBlobSchema = z.object({
  cid: z.string(),
  mimeType: z.string().nullable(),
  /** Base64 of the bytes as fetched from the owning repository. */
  bytes: z.string(),
});
export type DocumentSourceBlob = z.infer<typeof documentSourceBlobSchema>;

export const documentSourceSchema = z.object({
  uri: z.string(),
  cid: z.string(),
  /** Lossless JSON text of the record value, as the platform wrote it. */
  record: z.string(),
  blobs: z.array(documentSourceBlobSchema),
});
export type DocumentSource = z.infer<typeof documentSourceSchema>;

export const referenceSnapshotSchema = z.object({
  uri: z.string(),
  cid: z.string().nullable(),
  outcome: z.enum(REFERENCE_SNAPSHOT_OUTCOMES),
  /** Lossless JSON text of the record value; null unless resolved. */
  record: z.string().nullable(),
  resolvedAt: z.string(),
});
export type ReferenceSnapshot = z.infer<typeof referenceSnapshotSchema>;

export const readerBodySchema = z.discriminatedUnion("form", [
  z.object({
    form: z.literal("html"),
    html: z.string(),
    /** The item content hash. */
    revision: z.string(),
  }),
  z.object({
    form: z.literal("source"),
    source: documentSourceSchema,
    references: z.array(referenceSnapshotSchema),
    /** The source CID. Refreshed snapshots never change it. */
    revision: z.string(),
  }),
]);
export type ReaderBody = z.infer<typeof readerBodySchema>;
export type SourceReaderBody = Extract<ReaderBody, { form: "source" }>;

const BASE64_CHUNK = 0x8000;

/** Standard base64 without relying on `Uint8Array.fromBase64`, which browsers still lack. */
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK),
    );
  }
  return btoa(binary);
}

export function base64ToBytes(text: string) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function utf8Length(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

function base64DecodedLength(text: string) {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

/** Record text plus decoded blob bytes; the number the source budget bounds. */
export function documentSourceBytes(source: {
  record: string;
  blobs: ReadonlyArray<{ bytes: string }>;
}) {
  return source.blobs.reduce(
    (total, blob) => total + base64DecodedLength(blob.bytes),
    utf8Length(source.record),
  );
}

/** Serialized size estimate used to cap body responses. */
export function readerBodyBytes(body: ReaderBody) {
  if (body.form === "html") return utf8Length(body.html);
  return (
    utf8Length(body.source.record) +
    body.source.blobs.reduce((total, blob) => total + blob.bytes.length, 0) +
    body.references.reduce(
      (total, reference) => total + utf8Length(reference.record ?? ""),
      0,
    )
  );
}

export function isReferenceSnapshotStale(
  snapshot: Pick<ReferenceSnapshot, "outcome" | "resolvedAt">,
  now: number,
) {
  const age = now - Date.parse(snapshot.resolvedAt);
  if (!Number.isFinite(age)) return true;
  switch (snapshot.outcome) {
    case "unavailable":
      return true;
    case "missing":
    case "unsupported":
      return age >= REFERENCE_MISSING_RETRY_MS;
    case "resolved":
      return age >= REFERENCE_REFRESH_INTERVAL_MS;
  }
}
