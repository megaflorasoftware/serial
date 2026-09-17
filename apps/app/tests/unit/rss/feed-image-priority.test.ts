import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { FetchableOrigin } from "~/server/rss/types";
import type { ItemObservation } from "~/server/rss/itemObservation";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import {
  feedIngestState,
  feedItemObservations,
  feedItemPageImages,
  feedItems,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { writeObservedItems } from "~/server/rss/writeItems";
import { rssObservation } from "~/server/rss/itemObservation";
import { refreshPageImages } from "~/server/rss/refreshPageImages";
import { createPublicationClient } from "~/server/rss/atprotoClient";

vi.mock("~/server/logger", () => ({
  logMessage: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));
vi.mock("~/server/rss/feedCache", () => ({
  getCachedFeedResult: vi.fn(async () => null),
  setCachedFeedResult: vi.fn(async () => {}),
}));
vi.mock("~/server/rss/feedHttp", () => ({ readFeedHttp: vi.fn() }));
vi.mock("~/server/rss/atprotoClient", async (original) => ({
  ...(await original<typeof import("~/server/rss/atprotoClient")>()),
  createPublicationClient: vi.fn(),
}));

const PAGE = "https://www.serial.tube/releases/2026-08-07";
const OG = "https://www.serial.tube/og/releases/2026-08-07.png";
const BODY = "https://www.serial.tube/body.webp";
const PUB = "at://did:plc:alice/site.standard.publication/site";
const DATE = "2026-09-15T12:00:00Z";
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let fetchable: FetchableOrigin;
function response(url: string, text: string, status = 200) {
  return {
    ok: status === 200,
    status,
    statusText: "OK",
    url,
    headers: new Headers(),
    text,
  };
}
function observation(index = 0): ItemObservation {
  return rssObservation({
    id: `release-${index}`,
    title: "Bookmarked",
    author: "Serial",
    url: index ? `${PAGE}/${index}` : PAGE,
    publishedDate: DATE,
    content: `<p>Bookmarks</p><img src="${BODY}">`,
    mediaThumbnail: "",
    firstImageUrl: BODY,
  });
}
async function refresh() {
  const results = [];
  for await (const result of fetchAndInsertFeedData({ db: fixture.database }, [
    fetchable,
  ]))
    results.push(result);
  return results[0]!;
}
async function stored() {
  return (await fixture.database.select().from(feedItems))[0]!;
}
async function due() {
  await fixture.database
    .update(feedItemPageImages)
    .set({ nextCheckAt: new Date(0) });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createBookmarkTestDatabase();
  const database = fixture.database;
  await database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [feed] = await database
    .insert(feeds)
    .values({
      userId: "reader",
      name: "Releases",
      platform: "website",
      imageUrl: "",
      isActive: true,
    })
    .returning();
  const [origin] = await database
    .insert(feedOrigins)
    .values({
      userId: "reader",
      feedId: feed!.id,
      kind: "rss",
      locator: "https://www.serial.tube/releases/rss.xml",
    })
    .returning();
  fetchable = { feed: feed!, origin: origin! };
  vi.mocked(readFeedHttp)
    .mockReset()
    .mockImplementation(async (url) =>
      response(
        url,
        url.endsWith("rss.xml")
          ? `<rss version="2.0"><channel><title>Serial releases</title><link>https://www.serial.tube</link><item><guid>release-0</guid><link>${PAGE}</link><title>Bookmarked</title><description><![CDATA[<p>Bookmarks</p><img src="${BODY}">]]></description></item></channel></rss>`
          : `<meta property="og:image" content="${OG}">`,
      ),
    );
});
afterEach(() => fixture.cleanup());

it("persists the release OG image ahead of its RSS body screenshot and retains it on another fetch", async () => {
  expect((await refresh()).status).toBe("success");
  expect((await stored()).thumbnail).toBe(OG);
  vi.mocked(readFeedHttp).mockClear();
  await refresh();
  expect((await stored()).thumbnail).toBe(OG);
  expect(readFeedHttp).toHaveBeenCalledTimes(1);
});

it.each(["rss", "atproto"] as const)(
  "repairs existing %s items even when the origin is unchanged, preserving user state",
  async (kind) => {
    const source = {
      ...observation(),
      kind,
      ...(kind === "atproto"
        ? { key: "at://did:plc:alice/site.standard.document/post" }
        : {}),
    };
    await writeObservedItems(fixture.database, fetchable.feed, [source]);
    const original = await stored();
    await fixture.database
      .update(feedItems)
      .set({ isWatched: true, isWatchLater: true, progress: 42 });
    if (kind === "rss") {
      vi.mocked(readFeedHttp).mockImplementation(async (url) =>
        url.endsWith("rss.xml")
          ? response(url, "", 304)
          : response(url, `<meta property="og:image" content="${OG}">`),
      );
    } else {
      fetchable.origin.kind = "atproto";
      fetchable.origin.locator = PUB;
      fetchable.origin.repoRev = "same";
      await fixture.database
        .insert(feedIngestState)
        .values({ originId: fetchable.origin.id, initialized: true });
      vi.mocked(createPublicationClient).mockReturnValue({
        latestRev: vi.fn(async () => "same"),
      } as unknown as ReturnType<typeof createPublicationClient>);
    }
    const result = await refresh();
    expect(result).toMatchObject({
      status: "success",
      feedItems: [
        {
          id: original.id,
          thumbnail: OG,
          isWatched: true,
          isWatchLater: true,
          progress: 42,
        },
      ],
    });
    expect(await stored()).toMatchObject({
      id: original.id,
      thumbnail: OG,
      isWatched: true,
      isWatchLater: true,
      progress: 42,
    });
  },
);

it("enriches newly ingested Atmosphere documents through the same page-image path", async () => {
  fetchable.origin.kind = "atproto";
  fetchable.origin.locator = PUB;
  vi.mocked(createPublicationClient).mockReturnValue({
    latestRev: async () => "new",
    resolvePds: async () => "https://pds.example.com",
    getRecord: async () => ({
      uri: PUB,
      cid: "pub",
      value: { name: "Serial", url: "https://www.serial.tube" },
    }),
    list: async () => ({
      notModified: false,
      etag: null,
      cursor: undefined,
      records: [
        {
          uri: "at://did:plc:alice/site.standard.document/post",
          cid: "doc",
          value: {
            title: "Bookmarked",
            site: PUB,
            path: "/releases/2026-08-07",
            publishedAt: DATE,
            textContent: "Bookmarks",
          },
        },
      ],
    }),
    loadBlob: async () => new Uint8Array(),
    resolveRecord: async () => null,
  });
  expect((await refresh()).status).toBe("success");
  expect(await stored()).toMatchObject({
    thumbnail: OG,
    sourceKind: "atproto",
  });
});

it("preserves explicit covers and RSS media ahead of OG, and retries when they are removed", async () => {
  const rss = { ...observation(), thumbnail: "https://example.com/media.png" };
  const document = {
    ...observation(),
    kind: "atproto" as const,
    key: "at://did:plc:alice/site.standard.document/post",
    thumbnail: "https://example.com/cover.png",
  };
  await writeObservedItems(fixture.database, fetchable.feed, [rss, document]);
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe(document.thumbnail);
  expect(readFeedHttp).not.toHaveBeenCalled();
  await writeObservedItems(fixture.database, fetchable.feed, [
    { ...document, thumbnail: "" },
  ]);
  expect((await stored()).thumbnail).toBe(rss.thumbnail);
  await writeObservedItems(fixture.database, fetchable.feed, [
    { ...rss, thumbnail: "" },
  ]);
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe(OG);
});

it("advances past the first eight items and bounds concurrent page reads", async () => {
  await writeObservedItems(
    fixture.database,
    fetchable.feed,
    Array.from({ length: 20 }, (_, i) => observation(i)),
  );
  let active = 0;
  let maximum = 0;
  vi.mocked(readFeedHttp).mockImplementation(async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(url, `<meta property="og:image" content="${OG}">`);
  });
  for (const count of [8, 16, 20]) {
    await refreshPageImages(fixture.database, fetchable.feed);
    expect(readFeedHttp).toHaveBeenCalledTimes(count);
  }
  expect(maximum).toBeLessThanOrEqual(2);
  expect(
    vi
      .mocked(readFeedHttp)
      .mock.calls.every(
        ([, options]) =>
          options?.maxBodyBytes === 256 * 1024 &&
          options.totalDurationMs === 3_000,
      ),
  ).toBe(true);
});

it.each(["missing", "failure"])(
  "keeps the body fallback after a %s OG lookup",
  async (mode) => {
    await writeObservedItems(fixture.database, fetchable.feed, [observation()]);
    vi.mocked(readFeedHttp).mockImplementation(async (url) => {
      if (mode === "failure") throw new Error("timeout");
      return response(url, "<p>No metadata</p>");
    });
    await refreshPageImages(fixture.database, fetchable.feed);
    expect((await stored()).thumbnail).toBe(BODY);
    await refreshPageImages(fixture.database, fetchable.feed);
    expect(readFeedHttp).toHaveBeenCalledTimes(1);
  },
);

it("retains a previously fetched OG image on a temporary failure but clears removed metadata", async () => {
  await refresh();
  await due();
  vi.mocked(readFeedHttp).mockRejectedValue(new Error("timeout"));
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe(OG);
  await due();
  vi.mocked(readFeedHttp).mockImplementation(async (url) =>
    response(url, "<p>No metadata</p>"),
  );
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe(BODY);
});

it("resolves escaped relative OG metadata against the final redirected URL", async () => {
  await writeObservedItems(fixture.database, fetchable.feed, [observation()]);
  vi.mocked(readFeedHttp).mockResolvedValue(
    response(
      "https://cdn.example.com/article/",
      '<meta content="javascript:alert(1)" property="og:image:secure_url"><meta content="../image.png?a=1&amp;b=2" property="og:image">',
    ),
  );
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe(
    "https://cdn.example.com/image.png?a=1&b=2",
  );
});

it("discards an in-flight result after the document URL changes", async () => {
  await writeObservedItems(fixture.database, fetchable.feed, [
    {
      ...observation(),
      kind: "atproto",
      key: "at://did:plc:alice/site.standard.document/post",
    },
  ]);
  vi.mocked(readFeedHttp).mockImplementationOnce(async (url) => {
    await writeObservedItems(fixture.database, fetchable.feed, [
      {
        ...observation(),
        kind: "atproto",
        key: "at://did:plc:alice/site.standard.document/post",
        url: "https://example.com/moved",
      },
    ]);
    return response(url, `<meta property="og:image" content="${OG}">`);
  });
  await refreshPageImages(fixture.database, fetchable.feed);
  expect(await stored()).toMatchObject({
    url: "https://example.com/moved",
    thumbnail: BODY,
  });
  expect(
    (await fixture.database.select().from(feedItemPageImages))[0]?.imageUrl,
  ).toBeNull();
});

it("repairs a pre-observation row queued by the migration", async () => {
  await writeObservedItems(fixture.database, fetchable.feed, [observation()]);
  await fixture.database.delete(feedItemObservations);
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe(OG);
  expect((await stored()).id).toBeDefined();
});

it("does not overwrite a cover added while a page request is in flight", async () => {
  await writeObservedItems(fixture.database, fetchable.feed, [observation()]);
  vi.mocked(readFeedHttp).mockImplementationOnce(async (url) => {
    await writeObservedItems(fixture.database, fetchable.feed, [
      { ...observation(), thumbnail: "https://example.com/new-cover.png" },
    ]);
    return response(url, `<meta property="og:image" content="${OG}">`);
  });
  await refreshPageImages(fixture.database, fetchable.feed);
  expect((await stored()).thumbnail).toBe("https://example.com/new-cover.png");
});
