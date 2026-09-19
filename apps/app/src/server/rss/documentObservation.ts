import {
  buildBlueskyCdnImageUrl,
  buildCanonicalDocumentUrl,
  convertReaderBody,
  discoverReferences,
  DOCUMENT_SOURCE_BUDGET_BYTES,
  documentSourceBytes,
  isBlockNativeDocument,
  overflowBlobCid,
  referencedPublications,
  resolveDocumentSourceContent,
  snapshotLookup,
} from "@serial/standard-site";
import { OversizedDocumentSourceError } from "../jetstream/document-source";
import { itemUrl } from "./itemObservation";
import type {
  ConvertedDocument,
  DocumentSource,
  parseDocumentRecord,
  parsePublicationRecord,
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
  const bytes = await client.loadBlob(did, cid);
  const blobs = [{ cid, mimeType: "application/json", bytes }];
  const size = documentSourceBytes({
    record,
    blobs: [{ bytes: Buffer.from(bytes).toString("base64") }],
  });
  if (size > DOCUMENT_SOURCE_BUDGET_BYTES)
    throw new OversizedDocumentSourceError();
  return blobs;
}

/** The records this content renders, one level out: cards, mentions, galleries and their publications. */
export function contentReferences(
  content: unknown,
  did: string,
  records: (uri: string) => unknown,
) {
  const direct = discoverReferences(content, did);
  return [...direct, ...referencedPublications(direct, records)];
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
  | { kind: "source"; converted: ConvertedDocument }
  | { kind: "none" }
  | { kind: "rejected" };

export function deriveDocumentBody(
  document: ParsedDocument,
  body: SourceReaderBody,
  did: string,
): DocumentBodyOutcome {
  if (!isBlockNativeDocument(document.value)) return { kind: "none" };
  const converted = convertReaderBody(body, did);
  return converted ? { kind: "source", converted } : { kind: "rejected" };
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
  const converted =
    body.outcome.kind === "source" ? body.outcome.converted : null;
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
    firstParagraph: converted?.firstParagraph ?? "",
    firstImageUrl: converted?.firstImageUrl ?? "",
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

export { snapshotLookup };
