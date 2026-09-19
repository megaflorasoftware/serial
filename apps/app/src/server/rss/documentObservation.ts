import {
  buildBlueskyCdnImageUrl,
  buildCanonicalDocumentUrl,
  convertReaderBody,
  discoverReferences,
  DOCUMENT_SOURCE_BUDGET_BYTES,
  documentSourceBytes,
  overflowBlobCid,
  referencedPublications,
  resolveDocumentSourceContent,
  snapshotLookup,
} from "@serial/standard-site";
import type {
  DocumentSource,
  ReferenceSnapshot,
  SourceReaderBody,
} from "@serial/standard-site";
import { itemUrl } from "./itemObservation";
import { OversizedDocumentSourceError } from "../jetstream/document-source";
import type { FetchedBlob } from "../jetstream/document-source";
import type {
  parseDocumentRecord,
  parsePublicationRecord,
} from "@serial/standard-site";
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

/** The records this source renders, one level out: cards, mentions, galleries and their publications. */
export function documentReferences(
  source: DocumentSource,
  did: string,
  records: (uri: string) => unknown,
) {
  const content = resolveDocumentSourceContent(source);
  if (content === null) return [];
  const direct = discoverReferences(content, did);
  return [...direct, ...referencedPublications(direct, records)];
}

export class DocumentAdapterError extends Error {
  constructor() {
    super("Document source did not convert to a body");
  }
}

/**
 * One observation from a retained source. The adapter runs once here for the
 * snippet and first image; the client derives the Reader document itself.
 */
export function documentObservation(
  document: ParsedDocument,
  publication: ParsedPublication,
  did: string,
  body: SourceReaderBody,
): ItemObservation {
  const converted = convertReaderBody(body, did);
  if (!converted) throw new DocumentAdapterError();
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
    sourceCid: body.revision,
    firstParagraph: converted.firstParagraph ?? "",
    firstImageUrl: converted.firstImageUrl ?? "",
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
