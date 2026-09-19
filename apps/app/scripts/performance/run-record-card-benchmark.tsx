import { mkdirSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  convertDocumentContent,
  recordCardSchema,
} from "@serial/standard-site";
import { RecordCard } from "../../src/components/content-reader/RecordCard";

const did = "did:plc:benchmark";
const sizes = ["small", "medium", "large"] as const;
const preview = {
  url: "https://example.com/post",
  title: "A document",
  description: "A short description",
  publicationName: "Publication",
  author: "Author",
  publishedAt: "2026-09-18T00:00:00Z",
  imageUrl: "https://example.com/image.jpg",
};
/** Snapshot records as the reader reads them: one document per referenced uri. */
function referenced(uri: string) {
  return {
    uri,
    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    value: {
      site: "https://example.com",
      title: preview.title,
      description: preview.description,
      path: "/post",
      publishedAt: preview.publishedAt,
      contributors: [{ did, displayName: preview.author }],
    },
  };
}
const blocks = Array.from({ length: 100 }, (_, index) => [
  {
    block: {
      $type: "pub.leaflet.blocks.text",
      plaintext: `Paragraph ${index}: ${"Reader text. ".repeat(20)}`,
    },
  },
  {
    block: {
      $type: "pub.leaflet.blocks.standardSitePost",
      uri: `at://${did}/site.standard.document/${index % 16}`,
      size: sizes[index % 3],
    },
  },
]).flat();
const document = {
  content: {
    $type: "pub.leaflet.content",
    pages: [{ $type: "pub.leaflet.pages.linearDocument", blocks }],
  },
};
const cards = Array.from({ length: 100 }, (_, index) =>
  recordCardSchema.parse({
    ...preview,
    uri: `at://${did}/site.standard.document/${index % 16}`,
    size: sizes[index % 3],
  }),
);
const samples: Array<{
  conversionMs: number;
  renderMs: number;
  lookups: number;
}> = [];
for (let index = 0; index < 23; index++) {
  globalThis.gc?.();
  let lookups = 0;
  const start = performance.now();
  // Measure each sample in isolation so concurrent samples cannot distort timings.
  // react-doctor-disable-next-line react-doctor/async-await-in-loop
  const converted = await convertDocumentContent(document, {
    did,
    loadBlob: () => Promise.reject(new Error("Unexpected blob request")),
    records: (uri) => {
      lookups++;
      return referenced(uri);
    },
  });
  const convertedAt = performance.now();
  const rendered = renderToStaticMarkup(
    <>
      {cards.map((card, key) => (
        <RecordCard key={key} card={card} />
      ))}
    </>,
  );
  const end = performance.now();
  if (lookups !== 100 || !converted?.html || !rendered)
    throw new Error("Invalid benchmark workload");
  if (index >= 3)
    samples.push({
      conversionMs: convertedAt - start,
      renderMs: end - convertedAt,
      lookups,
    });
}
const summarize = (field: "conversionMs" | "renderMs") => {
  const values = samples.map((sample) => sample[field]).sort((a, b) => a - b);
  return { medianMs: values[9], p95Ms: values[18] };
};
const result = {
  paragraphs: 100,
  cards: 100,
  distinctReferences: 16,
  conversion: summarize("conversionMs"),
  render: summarize("renderMs"),
  samples,
};
mkdirSync("benchmarks/results", { recursive: true });
writeFileSync(
  "benchmarks/results/record-cards.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    conversion: result.conversion,
    render: result.render,
    lookups: 16,
  }),
);
