import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import { feedOrigins, user } from "~/server/db/schema";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { getDueFeedPage } from "~/server/rss/dueFeeds";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import { readFeedHttp } from "~/server/rss/feedHttp";

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

const FEED_URL = "https://blog.example.com/feed.xml";
const BODY = `<p>${"A long article body. ".repeat(100)}</p>`;
const DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Blog</title><link>https://blog.example.com</link><description>A blog</description>
${Array.from(
  { length: 20 },
  (_, index) => `<item><title>Post ${index}</title>
<link>https://blog.example.com/posts/${index}</link><guid>guid-${index}</guid>
<pubDate>Tue, 15 Sep 2026 12:00:00 GMT</pubDate>
<media:thumbnail url="https://blog.example.com/cover-${index}.png"/>
<content:encoded><![CDATA[${BODY}]]></content:encoded></item>`,
).join("\n")}
</channel></rss>`;

const WRITE = /^(insert into|update|delete from) /i;

let target: ReturnType<typeof createLocalBenchmarkTarget>;
let session: ReturnType<typeof openBenchmarkDatabase>;
let etag: string;

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
  await insertFeedWithOrigins(session.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Blog",
      platform: "website",
      imageUrl: "",
      origins: [{ kind: "rss", locator: FEED_URL }],
    },
  });
  etag = '"first"';
  // The server ignores validators: every fetch returns the whole document.
  vi.mocked(readFeedHttp).mockImplementation((url) =>
    url === FEED_URL
      ? Promise.resolve({
          headers: new Headers({ etag }),
          ok: true,
          status: 200,
          statusText: "OK",
          text: DOCUMENT,
          url,
        })
      : Promise.reject(new Error(`Unexpected request for ${url}`)),
  );
});

afterEach(() => {
  session.close();
  target.cleanup();
  vi.mocked(readFeedHttp).mockReset();
});

/** One fetch of the Feed's due origin, as the refresh pipeline loads and runs it. */
async function fetchDue() {
  await session.database.update(feedOrigins).set({ nextFetchAt: new Date(0) });
  const due = await getDueFeedPage(session.database, {
    userId: "reader",
    now: new Date(),
  });
  session.instrumentation.reset();
  const results = [];
  for await (const result of fetchAndInsertFeedData(
    { db: session.database },
    due,
  ))
    results.push(result);
  return { results, evidence: session.instrumentation.snapshot() };
}

it("costs two narrow reads and one row for a full fetch that changed nothing", async () => {
  const first = await fetchDue();
  expect(first.results).toMatchObject([{ status: "success" }]);
  expect(first.results[0]).toHaveProperty("feedItems.length", 20);

  const transaction = vi.spyOn(session.database, "transaction");
  const { results, evidence } = await fetchDue();
  expect(results).toMatchObject([{ status: "success", feedItems: [] }]);
  expect(transaction).not.toHaveBeenCalled();
  const writes = evidence.statements.filter((entry) => WRITE.test(entry.sql));
  // The origin's schedule, and nothing else.
  expect(writes.map((entry) => entry.sql)).toEqual([
    expect.stringMatching(/^update "serial_feed_origin" set/),
  ]);
  expect(evidence.statementCount).toBe(3);
  expect(
    evidence.statements.filter((entry) =>
      /"serial_feed_item"\."content"|"content",|"value"/.test(entry.sql),
    ),
  ).toEqual([]);
  // Only the feed itself was requested.
  expect(readFeedHttp).toHaveBeenCalledTimes(2);
});

it("writes the RSS detail row only when a validator changed", async () => {
  await fetchDue();
  etag = '"second"';
  const { evidence } = await fetchDue();
  expect(
    evidence.statements
      .filter((entry) => WRITE.test(entry.sql))
      .map((entry) => entry.sql.split(" set ")[0]),
  ).toEqual(['update "serial_feed_origin"', 'update "serial_feed_origin_rss"']);
});
