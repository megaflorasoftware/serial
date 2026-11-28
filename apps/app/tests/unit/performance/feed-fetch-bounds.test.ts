import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import type { CachedFeedResult } from "~/server/rss/feedCache";
import {
  feedItems,
  feedOriginRss,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { getDueFeedPage } from "~/server/rss/dueFeeds";
import {
  getCachedFeedResult,
  setCachedFeedResult,
} from "~/server/rss/feedCache";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { parsedFeedDigest } from "~/server/rss/parsedFeedDigest";

vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));
vi.mock("~/server/rss/feedCache", () => ({
  getCachedFeedResult: vi.fn(() => Promise.resolve(null)),
  setCachedFeedResult: vi.fn(() => Promise.resolve()),
}));
vi.mock("~/server/logger", () => ({
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const BLOG_URL = "https://blog.example.com/feed.xml";
const BODY = `<p>${"A long article body. ".repeat(100)}</p>`;
const POSTS = Array.from({ length: 20 }, (_, index) => ({
  title: `Post ${index}`,
  index,
}));

function blog(posts = POSTS) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Blog</title><link>https://blog.example.com</link><description>A blog</description>
${posts
  .map(
    ({ title, index }) => `<item><title>${title}</title>
<link>https://blog.example.com/posts/${index}</link><guid>guid-${index}</guid>
<pubDate>Tue, 15 Sep 2026 12:00:00 GMT</pubDate>
<media:thumbnail url="https://blog.example.com/cover-${index}.png"/>
<content:encoded><![CDATA[${BODY}]]></content:encoded></item>`,
  )
  .join("\n")}
</channel></rss>`;
}

const CHANNEL_URL =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCsBjURrPoezykLs9EqgamOA";
const CHANNEL = readFileSync(
  resolvePath(__dirname, "../../e2e/fixtures/fireship-old.xml"),
  "utf-8",
);
const CHANNEL_VIDEOS = 14;
/** The same channel before its first video. */
const CHANNEL_WITHOUT_VIDEOS = CHANNEL.replace(/<entry>[\s\S]*?<\/entry>/g, "");
const VIDEO_TITLE = "Tragic mistake... Anthropic leaks Claude’s source code";

const WRITE = /^(insert into|update|delete from) /i;
/** Any statement that reads or writes a Feed item, an observation or an alias. */
const ITEM_STATEMENT = /"serial_feed_item/;
const SCHEDULE_WRITE = /^update "serial_feed_origin" set/;

let target: ReturnType<typeof createLocalBenchmarkTarget>;
let session: ReturnType<typeof openBenchmarkDatabase>;
/** What each feed URL serves now. The server ignores validators and always sends the whole document. */
let served: Record<string, { text: string; etag: string }>;

beforeEach(async () => {
  target = createLocalBenchmarkTarget();
  session = openBenchmarkDatabase({ url: target.url });
  await applyMigrations(session.baseClient);
  const now = new Date();
  await session.database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  served = {
    [BLOG_URL]: { text: blog(), etag: '"first"' },
    [CHANNEL_URL]: { text: CHANNEL, etag: '"first"' },
  };
  vi.mocked(readFeedHttp).mockImplementation((url) => {
    const response = served[url];
    return response
      ? Promise.resolve({
          headers: new Headers({ etag: response.etag }),
          ok: true,
          status: 200,
          statusText: "OK",
          text: response.text,
          url,
        })
      : Promise.reject(new Error(`Unexpected request for ${url}`));
  });
});

afterEach(() => {
  session.close();
  target.cleanup();
  vi.mocked(readFeedHttp).mockReset();
  vi.mocked(getCachedFeedResult).mockReset();
  vi.mocked(getCachedFeedResult).mockResolvedValue(null);
  vi.mocked(setCachedFeedResult).mockClear();
});

function addFeed(platform: "website" | "youtube", locator: string) {
  return insertFeedWithOrigins(session.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Feed",
      platform,
      imageUrl: "",
      origins: [{ kind: "rss", locator }],
    },
  });
}

/** The Feed's due origin, as the refresh pipeline loads it. */
async function loadDue() {
  await session.database.update(feedOrigins).set({ nextFetchAt: new Date(0) });
  return getDueFeedPage(session.database, {
    userId: "reader",
    now: new Date(),
  });
}

async function fetchLoaded(due: Awaited<ReturnType<typeof loadDue>>) {
  session.instrumentation.reset();
  const results = [];
  for await (const result of fetchAndInsertFeedData(
    { db: session.database },
    due,
  ))
    results.push(result);
  return { results, evidence: session.instrumentation.snapshot() };
}

/** One fetch of the Feed's due origin. */
async function fetchDue() {
  return fetchLoaded(await loadDue());
}

async function storedDigest() {
  const [details] = await session.database.select().from(feedOriginRss);
  return details!.itemsDigest;
}

/** A result as the shared cache returns it: read back from its JSON. */
function fromSharedCache(result: unknown) {
  // The cache stores JSON, so dates return as text. A structured clone keeps them.
  // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone
  return JSON.parse(JSON.stringify(result)) as CachedFeedResult;
}

function writes(evidence: Awaited<ReturnType<typeof fetchDue>>["evidence"]) {
  return evidence.statements
    .filter((entry) => WRITE.test(entry.sql))
    .map((entry) => entry.sql.split(" set ")[0]);
}

function itemStatements(
  evidence: Awaited<ReturnType<typeof fetchDue>>["evidence"],
) {
  return evidence.statements.filter((entry) => ITEM_STATEMENT.test(entry.sql));
}

describe.each([
  {
    medium: "text",
    platform: "website",
    url: BLOG_URL,
    items: POSTS.length,
    empty: blog([]),
  },
  {
    medium: "video",
    platform: "youtube",
    url: CHANNEL_URL,
    items: CHANNEL_VIDEOS,
    empty: CHANNEL_WITHOUT_VIDEOS,
  },
] as const)("a $medium feed", ({ medium, platform, url, items, empty }) => {
  beforeEach(async () => {
    await addFeed(platform, url);
  });

  it("costs one origin row and no item statement when it parses as it did", async () => {
    const first = await fetchDue();
    expect(first.results).toMatchObject([{ status: "success" }]);
    expect(first.results[0]).toHaveProperty("feedItems.length", items);
    expect(await storedDigest()).toMatch(/^[0-9a-f]{64}$/);

    const transaction = vi.spyOn(session.database, "transaction");
    const { results, evidence } = await fetchDue();
    expect(results).toMatchObject([{ status: "success", feedItems: [] }]);
    expect(transaction).not.toHaveBeenCalled();
    // The origin's schedule, and nothing else.
    expect(evidence.statements.map((entry) => entry.sql)).toEqual([
      expect.stringMatching(SCHEDULE_WRITE),
    ]);
    // Only the feed itself was requested.
    expect(readFeedHttp).toHaveBeenCalledTimes(2);
  });

  it("costs the same when another reader's fetch supplies the parsed feed", async () => {
    await fetchDue();
    const [, parsed] = vi.mocked(setCachedFeedResult).mock.calls.at(-1)!;
    // The shared cache hands back what it serialized.
    vi.mocked(getCachedFeedResult).mockResolvedValue(fromSharedCache(parsed));
    const { results, evidence } = await fetchDue();
    expect(results).toMatchObject([
      { status: "success", feedItems: [], fromCache: true },
    ]);
    expect(evidence.statements.map((entry) => entry.sql)).toEqual([
      expect.stringMatching(SCHEDULE_WRITE),
    ]);
  });

  it("writes the RSS detail row only when a validator or the ingested feed changed", async () => {
    await fetchDue();
    served[url]!.etag = '"second"';
    const { evidence } = await fetchDue();
    expect(writes(evidence)).toEqual([
      'update "serial_feed_origin"',
      'update "serial_feed_origin_rss"',
    ]);
    expect(itemStatements(evidence)).toEqual([]);
  });

  it("reads the items again when the stored digest came from another derivation", async () => {
    await fetchDue();
    const current = await storedDigest();
    // What a bumped derivation version leaves behind: a digest no feed parses to.
    await session.database
      .update(feedOriginRss)
      .set({ itemsDigest: "digest-of-an-older-derivation" });
    const { results, evidence } = await fetchDue();
    expect(results).toMatchObject([{ status: "success", feedItems: [] }]);
    expect(itemStatements(evidence).length).toBeGreaterThan(0);
    expect(await storedDigest()).toBe(current);
    expect(itemStatements((await fetchDue()).evidence)).toEqual([]);
  });

  it("clears the digest when another fetch stored one while this one ran", async () => {
    await fetchDue();
    const due = await loadDue();
    await session.database
      .update(feedOriginRss)
      .set({ itemsDigest: "stored-by-an-overlapping-fetch" });
    served[url]!.text = served[url]!.text.replace(
      /<title>(Post 3|Tragic mistake[^<]*)<\/title>/,
      "<title>Retitled</title>",
    );
    const { results } = await fetchLoaded(due);
    expect(results[0]).toHaveProperty("feedItems.length", 1);
    // Neither fetch can tell whose items stand, so the next one reads them.
    expect(await storedDigest()).toBeNull();
    const next = await fetchDue();
    expect(itemStatements(next.evidence).length).toBeGreaterThan(0);
    expect(await storedDigest()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the digest of a feed that states no items, and reads none", async () => {
    served[url]!.text = empty;
    const first = await fetchDue();
    expect(first.results).toMatchObject([{ status: "empty" }]);
    expect(itemStatements(first.evidence)).toEqual([]);
    expect(await storedDigest()).toBe(parsedFeedDigest(medium, []));

    const { results, evidence } = await fetchDue();
    expect(results).toMatchObject([{ status: "empty" }]);
    expect(evidence.statements.map((entry) => entry.sql)).toEqual([
      expect.stringMatching(SCHEDULE_WRITE),
    ]);
    expect(await storedDigest()).toBe(parsedFeedDigest(medium, []));
  });

  it("keeps the same digest when another reader's fetch supplies the empty feed", async () => {
    served[url]!.text = empty;
    await fetchDue();
    const [, parsed] = vi.mocked(setCachedFeedResult).mock.calls.at(-1)!;
    expect(parsed).toMatchObject({ status: "empty" });
    // The shared cache hands back what it serialized, to an origin with no digest yet.
    vi.mocked(getCachedFeedResult).mockResolvedValue(fromSharedCache(parsed));
    await session.database.update(feedOriginRss).set({ itemsDigest: null });
    const first = await fetchDue();
    expect(first.results).toMatchObject([{ status: "empty", fromCache: true }]);
    expect(itemStatements(first.evidence)).toEqual([]);
    expect(await storedDigest()).toBe(parsedFeedDigest(medium, []));

    const { results, evidence } = await fetchDue();
    expect(results).toMatchObject([{ status: "empty", fromCache: true }]);
    expect(evidence.statements.map((entry) => entry.sql)).toEqual([
      expect.stringMatching(SCHEDULE_WRITE),
    ]);
    expect(await storedDigest()).toBe(parsedFeedDigest(medium, []));
  });
});

it("ingests a text item that changed after a skipped fetch", async () => {
  await addFeed("website", BLOG_URL);
  await fetchDue();
  expect(itemStatements((await fetchDue()).evidence)).toEqual([]);

  served[BLOG_URL]!.text = blog(
    POSTS.map((post) =>
      post.index === 3 ? { ...post, title: "Post 3, revised" } : post,
    ),
  );
  const { results } = await fetchDue();
  expect(results[0]).toMatchObject({
    status: "success",
    feedItems: [{ title: "Post 3, revised" }],
  });
  expect(
    await session.database
      .select({ title: feedItems.title })
      .from(feedItems)
      .where(eq(feedItems.url, "https://blog.example.com/posts/3")),
  ).toEqual([{ title: "Post 3, revised" }]);
  expect(itemStatements((await fetchDue()).evidence)).toEqual([]);
});

it("ingests a video item that changed after a skipped fetch", async () => {
  await addFeed("youtube", CHANNEL_URL);
  await fetchDue();
  expect(itemStatements((await fetchDue()).evidence)).toEqual([]);

  served[CHANNEL_URL]!.text = CHANNEL.replaceAll(VIDEO_TITLE, "Retitled video");
  const { results } = await fetchDue();
  expect(results[0]).toMatchObject({
    status: "success",
    feedItems: [{ title: "Retitled video" }],
  });
  expect(itemStatements((await fetchDue()).evidence)).toEqual([]);
});

it("takes the narrow item read when a text feed restates the same items", async () => {
  await addFeed("website", BLOG_URL);
  await fetchDue();
  // The same items in another order: a different document, with nothing to write.
  served[BLOG_URL]!.text = blog([...POSTS].reverse());
  const transaction = vi.spyOn(session.database, "transaction");
  const { results, evidence } = await fetchDue();
  expect(results).toMatchObject([{ status: "success", feedItems: [] }]);
  expect(transaction).not.toHaveBeenCalled();
  // The origin's schedule and the digest of the restated feed.
  expect(writes(evidence)).toEqual([
    'update "serial_feed_origin"',
    'update "serial_feed_origin_rss"',
  ]);
  expect(evidence.statementCount).toBe(4);
  expect(
    evidence.statements.filter((entry) =>
      /"serial_feed_item"\."content"|"content",|"value"/.test(entry.sql),
    ),
  ).toEqual([]);
});

it.each([
  { move: "video to text", from: "youtube", to: "website" },
  { move: "text to video", from: "website", to: "youtube" },
] as const)(
  "ingests again when the Feed moves from $move",
  async ({ from, to }) => {
    // Both ingests can read the channel's document.
    const feed = await addFeed(from, CHANNEL_URL);
    await fetchDue();
    const before = await storedDigest();
    expect(itemStatements((await fetchDue()).evidence)).toEqual([]);

    await session.database
      .update(feeds)
      .set({ platform: to })
      .where(eq(feeds.id, feed.id));
    const moved = await fetchDue();
    expect(moved.results).toMatchObject([{ status: "success" }]);
    // The Feed's new ingest reads what its old one stored.
    expect(itemStatements(moved.evidence).length).toBeGreaterThan(0);
    expect(await storedDigest()).not.toBe(before);
    expect(itemStatements((await fetchDue()).evidence)).toEqual([]);
  },
);

it("keeps the stored digest when an ingest fails", async () => {
  await addFeed("website", BLOG_URL);
  await fetchDue();
  const ingested = await storedDigest();
  served[BLOG_URL]!.text = blog(
    POSTS.map((post) =>
      post.index === 3 ? { ...post, title: "Post 3, revised" } : post,
    ),
  );
  vi.spyOn(session.database, "transaction").mockRejectedValueOnce(
    new Error("write failed"),
  );
  const failed = await fetchDue();
  expect(failed.results).toMatchObject([{ status: "error" }]);
  expect(await storedDigest()).toBe(ingested);
  // The same document is ingested on the next fetch, not skipped.
  const { results } = await fetchDue();
  expect(results[0]).toMatchObject({
    status: "success",
    feedItems: [{ title: "Post 3, revised" }],
  });
});
