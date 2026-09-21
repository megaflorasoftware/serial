import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore, Provider } from "jotai";
import {
  deriveReaderDocument,
  DOCUMENT_SOURCE_BUDGET_BYTES,
  parseAtUri,
  readerBodyBytes,
  readerDocumentBytes,
  stringifyLosslessJson,
} from "@serial/standard-site";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "./database";
import { ReaderDocumentContent } from "~/components/content-reader/ReaderDocumentContent";
import { flagAtoms } from "~/lib/hooks/useFlagState";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  capReaderBodies,
  loadReaderBodies,
} from "~/server/feeds/reader-bodies";
import {
  atprotoReferenceSnapshots,
  feedItems,
  feedOriginAtprotoDocuments,
  user,
} from "~/server/db/schema";
import { stageDocumentSource } from "~/server/jetstream/document-source";

/**
 * Measures the body endpoint against the real fixture documents: source
 * transfer size per document against the 128 KiB reader budget, the 4 MiB
 * offline budget, body load time, client derivation time, and a static React
 * render of the derived Reader document.
 */
const READER_TRANSFER_BUDGET = 128 * 1024;
const fixtures = resolve("../../packages/standard-site/tests/fixtures");
const target = createLocalBenchmarkTarget();
const session = openBenchmarkDatabase({ url: target.url });
try {
  await applyMigrations(session.baseClient);
  const now = new Date();
  await session.database.insert(user).values({
    id: "body-benchmark",
    name: "Body benchmark",
    email: "body@benchmark.invalid",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  const publications = JSON.parse(
    readFileSync(resolve(fixtures, "publications.json"), "utf8"),
  ) as Array<{ uri: string; cid: string; value: unknown }>;
  for (const publication of publications)
    // Snapshot rows are independent; insert in fixture order.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await session.database.insert(atprotoReferenceSnapshots).values({
      uri: publication.uri,
      cid: publication.cid,
      outcome: "resolved",
      record: stringifyLosslessJson(publication.value),
      resolvedAt: now,
      readAt: null,
    });
  const names = readdirSync(fixtures)
    .filter((file) => file.endsWith(".json") && file !== "publications.json")
    .map((file) => file.replace(/\.json$/, ""));
  for (const name of names) {
    const text = readFileSync(resolve(fixtures, `${name}.json`), "utf8");
    const record = JSON.parse(text) as {
      uri: string;
      cid: string;
      value: { site: string; title: string; publishedAt: string };
    };
    // One Feed per document keeps each source keyed to its own origin.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const feed = await insertFeedWithOrigins(session.database, {
      userId: "body-benchmark",
      isActive: true,
      details: {
        name,
        platform: "website",
        imageUrl: "",
        origins: [
          {
            kind: "atproto",
            // Legacy Leaflet documents name the pre-cutover publication collection.
            locator: record.value.site.replace(
              "/pub.leaflet.publication/",
              "/site.standard.publication/",
            ),
          },
        ],
      },
    });
    const originId = feed.origins[0]!.id;
    const key = { originId, uri: record.uri, cid: record.cid };
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await session.database
      .insert(feedOriginAtprotoDocuments)
      .values({ ...key, status: "ready", bodyCid: record.cid });
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await stageDocumentSource(
      session.database,
      key,
      stringifyLosslessJson(record.value),
      now,
    );
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await session.database.insert(feedItems).values({
      id: name,
      feedId: feed.id,
      contentId: record.uri,
      title: record.value.title,
      author: "",
      url: record.uri,
      contentHash: name,
      postedAt: new Date(record.value.publishedAt),
      atprotoUri: record.uri,
      sourceCid: record.cid,
      bodySource: "atproto",
    });
  }
  const rows = await session.database.select().from(feedItems);
  // The custom player needs the app's query client; the privacy embed does not.
  const renderStore = createStore();
  renderStore.set(flagAtoms.CUSTOM_VIDEO_PLAYER, "youtube");
  const samples: Array<{ loadMs: number; deriveMs: number; renderMs: number }> =
    [];
  let documents: Array<{
    id: string;
    transferBytes: number;
    derivedBytes: number;
    blocks: number;
    references: number;
    withinReaderBudget: boolean;
    withinOfflineBudget: boolean;
  }> = [];
  for (let i = 0; i < 18; i++) {
    globalThis.gc?.();
    session.instrumentation.reset();
    const started = performance.now();
    // Each sample loads every fixture body through the endpoint path.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const bodies = await loadReaderBodies(session.database, rows, now);
    const loaded = performance.now();
    const { items, omitted } = capReaderBodies(
      rows.map((row) => ({ id: row.id, body: bodies.get(row.id) ?? null })),
    );
    if (omitted.length) throw new Error("Fixture bodies exceeded the cap");
    const derivedDocuments = items.map(({ id, body }) => {
      if (body?.form !== "source") throw new Error(`No source body for ${id}`);
      const did = parseAtUri(body.source.uri)!.did;
      const document = deriveReaderDocument(body, did);
      if (!document) throw new Error(`Body ${id} did not derive`);
      return { id, body, document };
    });
    const derived = performance.now();
    for (const { document } of derivedDocuments) {
      renderToStaticMarkup(
        createElement(
          Provider,
          { store: renderStore },
          createElement(ReaderDocumentContent, {
            document,
            documentUrl: "https://example.com/",
            originActionLabel: "Open in Website",
          }),
        ),
      );
    }
    const rendered = performance.now();
    documents = derivedDocuments.map(({ id, body, document }) => {
      const transferBytes = readerBodyBytes(body);
      return {
        id,
        transferBytes,
        derivedBytes: readerDocumentBytes(document),
        blocks: document.blocks.length,
        references: body.references.length,
        withinReaderBudget: transferBytes <= READER_TRANSFER_BUDGET,
        withinOfflineBudget: transferBytes <= DOCUMENT_SOURCE_BUDGET_BYTES,
      };
    });
    if (i >= 3)
      samples.push({
        loadMs: loaded - started,
        deriveMs: derived - loaded,
        renderMs: rendered - derived,
      });
  }
  const sorted = (field: "loadMs" | "deriveMs" | "renderMs") =>
    samples.map((sample) => sample[field]).sort((a, b) => a - b);
  const result = {
    documents: documents.length,
    statementsPerLoad: session.instrumentation.snapshot().statementCount,
    load: { medianMs: sorted("loadMs")[7], p95Ms: sorted("loadMs")[14] },
    derive: { medianMs: sorted("deriveMs")[7], p95Ms: sorted("deriveMs")[14] },
    render: { medianMs: sorted("renderMs")[7], p95Ms: sorted("renderMs")[14] },
    largestTransferBytes: Math.max(...documents.map((d) => d.transferBytes)),
    readerBudgetBytes: READER_TRANSFER_BUDGET,
    offlineBudgetBytes: DOCUMENT_SOURCE_BUDGET_BYTES,
    perDocument: documents,
  };
  mkdirSync("benchmarks/results", { recursive: true });
  writeFileSync(
    "benchmarks/results/reader-body.json",
    JSON.stringify(result, null, 2),
  );
  console.log({ ...result, perDocument: undefined });
  console.table(
    documents.map(
      ({ id, transferBytes, derivedBytes, blocks, references }) => ({
        id,
        transferBytes,
        derivedBytes,
        blocks,
        references,
      }),
    ),
  );
  if (!documents.every((d) => d.withinReaderBudget && d.withinOfflineBudget))
    throw new Error("A fixture body exceeded its budget");
} finally {
  session.close();
  target.cleanup();
}
