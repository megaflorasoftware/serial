import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAtUri } from "../src/uris";
import { parseDocumentRecord } from "../src/lexicons";
import type { BlobLoader } from "../src/convert";

export const FIXTURE_DOCUMENTS = [
  "leaflet-legacy-site",
  "leaflet-montreal-recap",
  "leaflet-network-punk",
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

export function readFixture(name: string): unknown {
  const path = resolve(fixturesDirectory, `${name}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadDocumentFixture(name: FixtureName) {
  const record = parseDocumentRecord(readFixture(name));
  if (!record) throw new Error(`Fixture ${name} is not a document record`);
  const parts = parseAtUri(record.uri);
  if (!parts) throw new Error(`Fixture ${name} has an invalid uri`);
  return { record, did: parts.did };
}

export const rejectingBlobLoader: BlobLoader = (did, cid) =>
  Promise.reject(new Error(`unexpected blob load ${did} ${cid}`));

export function stubBlobLoader(blobs: Record<string, unknown>): BlobLoader {
  return (_did, cid) => {
    if (!(cid in blobs)) {
      return Promise.reject(new Error(`unknown blob ${cid}`));
    }
    return Promise.resolve(
      new TextEncoder().encode(JSON.stringify(blobs[cid])),
    );
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
