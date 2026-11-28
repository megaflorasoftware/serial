import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import {
  applyJournalRange,
  featureIndex,
  readJournal,
} from "./migration-journal";
import { getDueFeedPage } from "~/server/rss/dueFeeds";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { computeItemHash } from "~/server/rss/hash";

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
const CHANNEL_URL =
  "https://www.youtube.com/feeds/videos.xml?channel_id=UCexample";
const PUBLISHED = "Tue, 15 Sep 2026 12:00:00 GMT";
const BODY = `<p>${"A long article body. ".repeat(100)}</p>`;
const POSTS = Array.from({ length: 5 }, (_, index) => ({
  id: `guid-${index}`,
  title: `Post ${index}`,
  url: `https://blog.example.com/posts/${index}`,
  thumbnail: `https://blog.example.com/cover-${index}.png`,
}));
const BLOG = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Blog</title><link>https://blog.example.com</link><description>A blog</description>
${POSTS.map(
  (post) => `<item><title>${post.title}</title>
<link>${post.url}</link><guid>${post.id}</guid>
<pubDate>${PUBLISHED}</pubDate>
<media:thumbnail url="${post.thumbnail}"/>
<content:encoded><![CDATA[${BODY}]]></content:encoded></item>`,
).join("\n")}
</channel></rss>`;

// Plain text that HTML would read as markup. It is stored as the feed states it.
const DESCRIPTION = "Q&A with <tips> & more";
const VIDEO = {
  id: "vd14EElCRvs",
  title: "A video",
  url: "https://www.youtube.com/watch?v=vd14EElCRvs",
  thumbnail: "https://i3.ytimg.com/vi/vd14EElCRvs/hqdefault.jpg",
  published: "2026-04-02T19:18:38+00:00",
};
const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const channelDocument = (
  description: string,
) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="${CHANNEL_URL.replace("&", "&amp;")}"/>
 <id>yt:channel:example</id>
 <title>Channel</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCexample"/>
 <author><name>Channel</name><uri>https://www.youtube.com/channel/UCexample</uri></author>
 <published>2017-04-07T18:17:23+00:00</published>
 <entry>
  <id>yt:video:${VIDEO.id}</id>
  <yt:videoId>${VIDEO.id}</yt:videoId>
  <title>${VIDEO.title}</title>
  <link rel="alternate" href="${VIDEO.url}"/>
  <author><name>Channel</name><uri>https://www.youtube.com/channel/UCexample</uri></author>
  <published>${VIDEO.published}</published>
  <updated>${VIDEO.published}</updated>
  <media:group>
   <media:title>${VIDEO.title}</media:title>
   <media:thumbnail url="${VIDEO.thumbnail}" width="480" height="360"/>
   <media:description>${escapeXml(description)}</media:description>
  </media:group>
 </entry>
</feed>`;

const WRITE = /^(insert into|update|delete from) /i;
const UPGRADED_AT = 1_700_000_000;

let target: ReturnType<typeof createLocalBenchmarkTarget>;
let session: ReturnType<typeof openBenchmarkDatabase>;
let channelDescription: string;

/** A Feed item as the release before Feed origins stored it, with that release's hash. */
function legacyItem(input: {
  id: string;
  feedId: number;
  contentType: "text" | "video";
  title: string;
  author: string;
  url: string;
  content: string;
  thumbnail: string;
  postedAt: Date;
}) {
  return {
    sql: `INSERT INTO serial_feed_item
      (id, feed_id, content_id, title, author, url, content, content_snippet,
       content_type, thumbnail, posted_at, created_at, updated_at, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
    args: [
      `item-${input.id}`,
      input.feedId,
      input.id,
      input.title,
      input.author,
      input.url,
      input.content,
      input.contentType,
      input.thumbnail,
      Math.floor(input.postedAt.getTime() / 1000),
      UPGRADED_AT,
      UPGRADED_AT,
      computeItemHash({
        contentId: input.id,
        title: input.title,
        author: input.author,
        content: input.content,
        thumbnail: input.thumbnail,
        postedAt: input.postedAt,
      }),
    ],
  };
}

beforeEach(async () => {
  target = createLocalBenchmarkTarget();
  session = openBenchmarkDatabase({ url: target.url });
  const journal = readJournal();
  const upgrade = featureIndex(journal);
  const client = session.baseClient;
  await applyJournalRange(client, journal.entries, 0, upgrade - 1, {
    withPostMigrations: true,
  });
  await client.execute({
    sql: `INSERT INTO serial_user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('reader', 'Reader', 'reader@example.com', 1, ?, ?)`,
    args: [UPGRADED_AT, UPGRADED_AT],
  });
  // Both Feeds were fetched before the upgrade and are due again.
  await client.execute({
    sql: `INSERT INTO serial_feed
      (id, user_id, name, url, image_url, platform, open_location, created_at,
       updated_at, last_fetched_at, next_fetch_at, is_active, etag, last_modified_header)
      VALUES
      (1, 'reader', 'Blog', ?, '', 'website', 'serial', ?, ?, ?, ?, 1, '"blog"', NULL),
      (2, 'reader', 'Channel', ?, '', 'youtube', 'serial', ?, ?, ?, ?, 1, '"channel"', NULL)`,
    args: [
      BLOG_URL,
      UPGRADED_AT,
      UPGRADED_AT,
      UPGRADED_AT - 3600,
      UPGRADED_AT - 60,
      CHANNEL_URL,
      UPGRADED_AT,
      UPGRADED_AT,
      UPGRADED_AT - 3600,
      UPGRADED_AT - 60,
    ],
  });
  await client.batch(
    [
      ...POSTS.map((post) =>
        legacyItem({
          ...post,
          feedId: 1,
          contentType: "text",
          author: "",
          content: BODY,
          postedAt: new Date(PUBLISHED),
        }),
      ),
      legacyItem({
        ...VIDEO,
        feedId: 2,
        contentType: "video",
        author: "Channel",
        content: DESCRIPTION,
        postedAt: new Date(VIDEO.published),
      }),
    ],
    "write",
  );
  await applyJournalRange(client, journal.entries, upgrade, upgrade, {
    withPostMigrations: true,
  });
  // The origins lost their validators in the upgrade, so the servers answer
  // with whole documents.
  channelDescription = DESCRIPTION;
  vi.mocked(readFeedHttp).mockImplementation((url) => {
    const text = {
      [BLOG_URL]: BLOG,
      [CHANNEL_URL]: channelDocument(channelDescription),
    }[url];
    return text
      ? Promise.resolve({
          headers: new Headers(),
          ok: true,
          status: 200,
          statusText: "OK",
          text,
          url,
        })
      : Promise.reject(new Error(`Unexpected request for ${url}`));
  });
});

afterEach(() => {
  session.close();
  target.cleanup();
  vi.mocked(readFeedHttp).mockReset();
});

const storedItems = async () =>
  (
    await session.baseClient.execute(
      "SELECT * FROM serial_feed_item ORDER BY id",
    )
  ).rows;

async function count(table: string) {
  const result = await session.baseClient.execute(
    `SELECT count(*) AS value FROM ${table}`,
  );
  return Number(result.rows[0]?.value);
}

/**
 * A refresh of both Feeds, which answer in full. The upgrade leaves them due;
 * a later refresh has to bring their schedules back first.
 */
async function fetchDue(options: { again?: boolean } = {}) {
  if (options.again)
    await session.baseClient.execute(
      "UPDATE serial_feed_origin SET next_fetch_at = 0",
    );
  const due = await getDueFeedPage(session.database, {
    userId: "reader",
    now: new Date(),
  });
  expect(due.map(({ feed }) => feed.id)).toEqual([1, 2]);
  session.instrumentation.reset();
  const results = [];
  for await (const result of fetchAndInsertFeedData(
    { db: session.database },
    due,
  ))
    results.push(result);
  return { results, ...session.instrumentation.snapshot() };
}

it("writes no item for a Feed that says the same on its first fetch after the upgrade", async () => {
  const before = await storedItems();
  expect(before).toHaveLength(POSTS.length + 1);
  // The upgrade itself rewrote no item.
  expect(before.map((row) => row.body_source)).toEqual(before.map(() => null));

  const { results, statements } = await fetchDue();

  expect(results).toHaveLength(2);
  for (const result of results)
    expect(result).toMatchObject({ status: "success", feedItems: [] });
  // Only the two feeds were requested: no page was read for an old item.
  expect(readFeedHttp).toHaveBeenCalledTimes(2);

  const writes = statements
    .filter((entry) => WRITE.test(entry.sql))
    .map((entry) => entry.sql);
  // The full fetch fills what the upgrade left empty and moves the schedule.
  expect(writes.length).toBeGreaterThan(0);
  for (const sql of writes)
    expect(sql).toMatch(/^update "serial_feed(_origin|_origin_rss)?" set /);
  expect(await storedItems()).toEqual(before);
  expect(await count("serial_feed_item_observation")).toBe(0);
  expect(await count("serial_feed_item_alias")).toBe(0);
  const blog = await session.baseClient.execute(
    "SELECT site_url FROM serial_feed WHERE id = 1",
  );
  expect(blog.rows).toEqual([{ site_url: "https://blog.example.com/" }]);
});

it("reads the items on the first fetch after the upgrade and not on the next", async () => {
  const before = await storedItems();
  const digests = () =>
    session.baseClient.execute(
      "SELECT items_digest FROM serial_feed_origin_rss ORDER BY origin_id",
    );
  // The upgrade knows of no ingested feed.
  expect((await digests()).rows).toEqual([
    { items_digest: null },
    { items_digest: null },
  ]);
  const itemStatements = (statements: Array<{ sql: string }>) =>
    statements.filter((entry) => /"serial_feed_item/.test(entry.sql));

  const first = await fetchDue();
  expect(itemStatements(first.statements).length).toBeGreaterThan(0);
  for (const row of (await digests()).rows)
    expect(row.items_digest).toMatch(/^[0-9a-f]{64}$/);

  // The same feeds again touch no item, observed or not.
  const next = await fetchDue({ again: true });
  expect(itemStatements(next.statements)).toEqual([]);
  expect(await storedItems()).toEqual(before);
});

it("rewrites a video only when its feed changed the description, storing it as stated", async () => {
  const before = await storedItems();
  channelDescription = "Q&A, edited <tips> & more";

  const { results } = await fetchDue();

  expect(results.map((result) => result.id).sort()).toEqual([1, 2]);
  const written = results.flatMap((result) =>
    "feedItems" in result ? (result.feedItems ?? []) : [],
  );
  expect(written.map((item) => item.id)).toEqual([`item-${VIDEO.id}`]);
  const after = await storedItems();
  // The articles are untouched; only the edited video moved.
  expect(after.filter((row) => row.feed_id === 1)).toEqual(
    before.filter((row) => row.feed_id === 1),
  );
  const video = after.find((row) => row.feed_id === 2)!;
  expect(video.content).toBe(channelDescription);
  // The hash describes what is stored, as it did before the upgrade.
  expect(video.content_hash).toBe(
    computeItemHash({
      contentId: VIDEO.id,
      title: VIDEO.title,
      author: "Channel",
      content: channelDescription,
      thumbnail: VIDEO.thumbnail,
      postedAt: new Date(VIDEO.published),
    }),
  );
  // The same description again is no change.
  expect((await fetchDue({ again: true })).results).toMatchObject([
    { feedItems: [] },
    { feedItems: [] },
  ]);
  expect(await storedItems()).toEqual(after);
});
