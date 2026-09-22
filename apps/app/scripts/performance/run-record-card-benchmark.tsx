import { mkdirSync, writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { deriveResolvedContent, recordCardSchema } from "@serial/standard-site";
import { RecordCard } from "../../src/components/content-reader/RecordCard";
import { SocialPostCard } from "../../src/components/content-reader/SocialPostCard";
import type { ReaderSocialPost } from "@serial/standard-site";

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
const content = {
  $type: "pub.leaflet.content",
  pages: [{ $type: "pub.leaflet.pages.linearDocument", blocks }],
};
const cards = Array.from({ length: 100 }, (_, index) =>
  recordCardSchema.parse({
    ...preview,
    uri: `at://${did}/site.standard.document/${index % 16}`,
    size: sizes[index % 3],
  }),
);
/** One social card per platform, the shape the adapters emit for a resolved post. */
const socialPosts: ReaderSocialPost[] = Array.from(
  { length: 100 },
  (_, index) => {
    const platform = index % 2 ? "pckt" : "bluesky";
    const authorDid = `did:plc:author${index % 16}`;
    return {
      platform,
      uri: `at://${authorDid}/${platform === "pckt" ? "blog.pckt.mini.post" : "app.bsky.feed.post"}/${index}`,
      url:
        platform === "pckt"
          ? `https://pckt.blog/n/${authorDid}/${index}`
          : `https://bsky.app/profile/${authorDid}/post/${index}`,
      author: {
        did: authorDid,
        handle: `author${index % 16}.example`,
        name: platform === "pckt" ? "A Blog" : "An Author",
        avatarUrl: `https://cdn.bsky.app/img/avatar/plain/${authorDid}/bafyavatar@jpeg`,
        url: `https://bsky.app/profile/${authorDid}`,
      },
      siteUrl: platform === "pckt" ? "https://blog.example" : null,
      text: [
        { kind: "text", text: `Post ${index}: `, marks: {}, link: null },
        {
          kind: "text",
          text: "a link",
          marks: {},
          link: { href: "https://example.com/", record: null },
        },
      ],
      createdAt: preview.publishedAt,
      images:
        index % 3 === 0
          ? [
              {
                url: `https://cdn.bsky.app/img/feed_fullsize/plain/${authorDid}/bafyimage@jpeg`,
                alt: "Image",
                title: null,
                aspectRatio: { width: 4, height: 3 },
                width: null,
                fullBleed: false,
              },
            ]
          : [],
      external: null,
      video: null,
      quote: null,
      mediaHidden: false,
    };
  },
);
const samples: Array<{
  conversionMs: number;
  renderMs: number;
  socialRenderMs: number;
  lookups: number;
}> = [];
for (let index = 0; index < 23; index++) {
  globalThis.gc?.();
  let lookups = 0;
  const start = performance.now();
  const derived = deriveResolvedContent(content, did, (uri) => {
    lookups++;
    return referenced(uri);
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
  const socialRendered = renderToStaticMarkup(
    <>
      {socialPosts.map((post, key) => (
        <SocialPostCard
          key={key}
          post={post}
          text={post.text.map((inline) =>
            inline.kind === "text" ? inline.text : "",
          )}
          quote={null}
        />
      ))}
    </>,
  );
  const socialEnd = performance.now();
  if (
    lookups !== 100 ||
    !derived?.blocks.length ||
    !rendered ||
    !socialRendered
  )
    throw new Error("Invalid benchmark workload");
  if (index >= 3)
    samples.push({
      conversionMs: convertedAt - start,
      renderMs: end - convertedAt,
      socialRenderMs: socialEnd - end,
      lookups,
    });
}
const summarize = (field: "conversionMs" | "renderMs" | "socialRenderMs") => {
  const values = samples.map((sample) => sample[field]).sort((a, b) => a - b);
  return { medianMs: values[9], p95Ms: values[18] };
};
const result = {
  paragraphs: 100,
  cards: 100,
  distinctReferences: 16,
  conversion: summarize("conversionMs"),
  render: summarize("renderMs"),
  socialCards: 100,
  socialRender: summarize("socialRenderMs"),
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
    socialRender: result.socialRender,
    lookups: 100,
  }),
);
