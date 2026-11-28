import {
  buildBlueskyCdnImageUrl,
  buildCanonicalDocumentUrl,
  bytesToBase64,
  deriveReaderDocument,
  discoverReferences,
  DOCUMENT_SOURCE_BUDGET_BYTES,
  isBlockNativeDocument,
  overflowBlobCid,
  resolveDocumentSourceContent,
  summarizeReaderDocument,
} from "@serial/standard-site";
import { OversizedDocumentSourceError } from "../jetstream/document-source";
import { itemUrl } from "./itemObservation";
import type {
  DocumentSource,
  parseDocumentRecord,
  parsePublicationRecord,
  ReaderSummary,
  ReferenceSnapshot,
  SourceReaderBody,
} from "@serial/standard-site";
import type { FetchedBlob } from "../jetstream/document-source";
import type { PublicationClient } from "./atprotoClient";
import type { ItemObservation } from "./itemObservation";

type ParsedDocument = NonNullable<ReturnType<typeof parseDocumentRecord>>;
type ParsedPublication = NonNullable<ReturnType<typeof parsePublicationRecord>>;

/**
 * Fetches the one overflow blob a document may point at and checks the whole
 * source against its budget. Nothing is retained over budget.
 */
export async function fetchDocumentBlobs(
  document: ParsedDocument,
  record: string,
  did: string,
  client: Pick<PublicationClient, "loadBlob">,
): Promise<FetchedBlob[]> {
  const cid = overflowBlobCid(document.value.content);
  if (!cid) return [];
  const { bytes, mimeType } = await client.loadBlob(did, cid);
  const size = utf8Length(record) + bytes.byteLength;
  if (size > DOCUMENT_SOURCE_BUDGET_BYTES)
    throw new OversizedDocumentSourceError();
  return [{ cid, mimeType, bytes }];
}

function utf8Length(text: string) {
  return new TextEncoder().encode(text).byteLength;
}

/** The Document source as the Reader body and the store carry it. */
export function retainedSource(
  key: { uri: string; cid: string },
  record: string,
  blobs: FetchedBlob[],
): DocumentSource {
  return {
    uri: key.uri,
    cid: key.cid,
    record,
    blobs: blobs.map((blob) => ({
      cid: blob.cid,
      mimeType: blob.mimeType,
      bytes: bytesToBase64(blob.bytes),
    })),
  };
}

/** Direct references of a retained source; empty when the source is not renderable. */
export function documentReferences(source: DocumentSource, did: string) {
  const content = resolveDocumentSourceContent(source);
  return content === null ? [] : discoverReferences(content, did);
}

/**
 * How the document's body came out: a readable source, no body at all (the
 * document is not block-native), or a source the adapter rejected.
 */
export type DocumentBodyOutcome =
  | { kind: "source"; summary: ReaderSummary }
  | { kind: "none" }
  | { kind: "rejected" };

export function deriveDocumentBody(
  document: ParsedDocument,
  body: SourceReaderBody,
  did: string,
): DocumentBodyOutcome {
  if (!isBlockNativeDocument(document.value)) return { kind: "none" };
  const derived = deriveReaderDocument(body, did);
  return derived
    ? { kind: "source", summary: summarizeReaderDocument(derived) }
    : { kind: "rejected" };
}

/**
 * One observation from a retained source. The adapter runs once here for the
 * snippet and first image; the client derives the Reader document itself. A
 * rejected or absent body keeps the last readable version, never erasing it.
 */
export function documentObservation(
  document: ParsedDocument,
  publication: ParsedPublication,
  did: string,
  body: {
    outcome: DocumentBodyOutcome;
    cid: string;
    readableCid: string | null;
  },
): ItemObservation {
  const summary = body.outcome.kind === "source" ? body.outcome.summary : null;
  const sourceCid =
    body.outcome.kind === "source" ? body.cid : (body.readableCid ?? undefined);
  const canonical = buildCanonicalDocumentUrl(
    publication.value.url,
    document.value.path,
  );
  return {
    kind: "atproto",
    key: document.uri,
    url: itemUrl(canonical ?? document.uri),
    title: document.value.title,
    author:
      document.value.contributors
        ?.map((entry) => entry.displayName?.trim())
        .filter(Boolean)
        .join(", ") ?? "",
    description: document.value.description ?? "",
    thumbnail: document.value.coverImage
      ? (buildBlueskyCdnImageUrl(did, document.value.coverImage.ref.$link) ??
        "")
      : "",
    content: "",
    ...(sourceCid ? { sourceCid } : {}),
    firstParagraph: summary?.firstParagraph ?? "",
    firstImageUrl: summary?.firstImageUrl ?? "",
    publishedAt: document.value.publishedAt,
    tags: document.value.tags ?? [],
    publicationName: publication.value.name,
  };
}

export function sourceReaderBody(
  source: DocumentSource,
  references: ReferenceSnapshot[],
): SourceReaderBody {
  return { form: "source", source, references, revision: source.cid };
}
