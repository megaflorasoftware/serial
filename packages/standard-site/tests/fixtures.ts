import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAtUri } from "../src/uris";
import { parseDocumentRecord } from "../src/lexicons";
import { stringifyLosslessJson } from "../src/lossless-json";
import type { ReaderBlock, ReaderDocument } from "../src/reader/model";
import type { SourceReaderBody } from "../src/reader-body";

export const FIXTURE_DOCUMENTS = [
  "leaflet-legacy-site",
  "leaflet-montreal-recap",
  "leaflet-network-punk",
  "leaflet-what-is-the-atmosphere",
  "leaflet-poll-block",
  "leaflet-reader-code-block",
  "offprint-bluesky-and-did-plc",
  "offprint-interactive-transcripts",
  "offprint-nyc-community-day",
  "offprint-open-social-awards",
  "pckt-cant-stop-crediting",
  "pckt-science-vs-vegetable-faces",
] as const;

export type FixtureName = (typeof FIXTURE_DOCUMENTS)[number];

const fixturesDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

export function readFixtureText(name: string): string {
  return readFileSync(resolve(fixturesDirectory, `${name}.json`), "utf8");
}

export function readFixture(name: string): unknown {
  return JSON.parse(readFixtureText(name));
}

export function loadDocumentFixture(name: FixtureName) {
  const record = parseDocumentRecord(readFixture(name));
  if (!record) throw new Error(`Fixture ${name} is not a document record`);
  const parts = parseAtUri(record.uri);
  if (!parts) throw new Error(`Fixture ${name} has an invalid uri`);
  return { record, did: parts.did };
}

/** The publication fixtures as resolved Reference snapshots. */
export function publicationSnapshots(): SourceReaderBody["references"] {
  return (
    readFixture("publications") as Array<{
      uri: string;
      cid: string;
      value: unknown;
    }>
  ).map((publication) => ({
    uri: publication.uri,
    cid: publication.cid,
    outcome: "resolved",
    record: stringifyLosslessJson(publication.value),
    resolvedAt: "2026-09-19T00:00:00Z",
  }));
}

/** A fixture as the body endpoint would return it: source text plus snapshots. */
export function fixtureReaderBody(name: FixtureName): SourceReaderBody {
  const { record } = loadDocumentFixture(name);
  const value = JSON.parse(readFixtureText(name)) as { value: unknown };
  return {
    form: "source",
    source: {
      uri: record.uri,
      cid: record.cid,
      record: stringifyLosslessJson(value.value),
      blobs: [],
    },
    references: publicationSnapshots(),
    revision: record.cid,
  };
}

export function leaflet(blocks: Array<Record<string, unknown>>) {
  return {
    $type: "pub.leaflet.content",
    pages: [
      {
        $type: "pub.leaflet.pages.linearDocument",
        blocks: blocks.map((block) => ({ block })),
      },
    ],
  };
}

export function offprint(items: Array<Record<string, unknown>>) {
  return { $type: "app.offprint.content", items };
}

export function pckt(items: Array<Record<string, unknown>>) {
  return { $type: "blog.pckt.content", items };
}

/** Block kinds in document order, nesting included, for terse assertions. */
export function kinds(blocks: ReaderBlock[]): string[] {
  return blocks.flatMap((block) => {
    switch (block.kind) {
      case "quotation":
        return [block.kind, ...kinds(block.children)];
      case "list":
        return [
          block.kind,
          ...block.items.flatMap((item) => kinds(item.content)),
        ];
      case "table":
        return [
          block.kind,
          ...block.rows.flatMap((row) =>
            row.flatMap((cell) => kinds(cell.content)),
          ),
        ];
      default:
        return [block.kind];
    }
  });
}

/** Strips `source` so snapshots hold only the typed part the reader draws. */
export function typedDocument(document: ReaderDocument) {
  return JSON.parse(
    JSON.stringify(document, (key, value) =>
      key === "source" ? undefined : value,
    ),
  ) as ReaderDocument;
}
