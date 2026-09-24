import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { recoverRepository } from "../jetstream/repository-recovery";
import type * as AtprotoClientModule from "~/server/rss/atprotoClient";
import type { FetchableOrigin } from "~/server/rss/types";
import type { ItemObservation } from "~/server/rss/itemObservation";
import {
  attachMissingFeedOrigins,
  insertFeedWithOrigins,
} from "~/server/feeds/origins";
import { fetchAndInsertFeedData } from "~/server/rss/fetchFeeds";
import {
  feedItems,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  user,
} from "~/server/db/schema";
import { readFeedHttp } from "~/server/rss/feedHttp";
import { writeObservedItems } from "~/server/rss/writeItems";
import { rssObservation } from "~/server/rss/itemObservation";
import { enrichObservationImages } from "~/server/rss/observationImages";
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
  ...(await original<typeof AtprotoClientModule>()),
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
  if (fetchable.origin.kind === "atproto")
    return recoverRepository(fixture.database, fetchable.origin.id, {
      client: createPublicationClient(),
      readPage: readFeedHttp,
    });
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
async function writeEnriched(incoming: ItemObservation[]) {
  return writeObservedItems(
    fixture.database,
    fetchable.feed,
    await enrichObservationImages(incoming),
  );
}
async function useAtmosphere() {
  const feed = await attachMissingFeedOrigins(
    fixture.database,
    { ...fetchable.feed, origins: [fetchable.origin] },
    [{ kind: "atproto", locator: PUB }],
  );
  fetchable = {
    feed,
    origin: feed.origins.find((origin) => origin.kind === "atproto")!,
  };
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
  const feed = await insertFeedWithOrigins(database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Releases",
      platform: "website",
      imageUrl: "",
      origins: [
        { kind: "rss", locator: "https://www.serial.tube/releases/rss.xml" },
      ],
    },
  });
  fetchable = { feed, origin: feed.origins[0]! };
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
  await refresh();
  expect((await stored()).thumbnail).toBe(OG);
  vi.mocked(readFeedHttp).mockClear();
  await refresh();
  expect((await stored()).thumbnail).toBe(OG);
  expect(readFeedHttp).toHaveBeenCalledTimes(2);
});

it.each(["rss", "atproto"] as const)(
  "does no image work for an unchanged %s origin",
  async (kind) => {
    if (kind === "atproto") await useAtmosphere();
    await writeObservedItems(fixture.database, fetchable.feed, [
      {
        ...observation(),
        kind,
        key:
          kind === "atproto"
            ? "at://did:plc:alice/site.standard.document/post"
            : "release-0",
      },
    ]);
    const original = await stored();
    await fixture.database
      .update(feedItems)
      .set({ isWatched: true, isWatchLater: true, progress: 42 });
    if (kind === "rss")
      vi.mocked(readFeedHttp).mockImplementation(async (url) =>
        response(url, "", 304),
      );
    else {
      await fixture.database.update(feedOriginAtproto).set({
        initialized: true,
        listingEtag: '"same"',
      });
      vi.mocked(createPublicationClient).mockReturnValue({
        latestRev: async () => "same",
        getRecord: async () => ({
          uri: PUB,
          cid: "pub",
          value: { name: "Serial", url: "https://www.serial.tube" },
        }),
        list: async () => ({ notModified: true, records: [], etag: '"same"' }),
      } as unknown as ReturnType<typeof createPublicationClient>);
    }
    const result = await refresh();
    if (kind === "rss") expect(result?.status).toBe("skipped");
    expect(await stored()).toMatchObject({
      id: original.id,
      thumbnail: BODY,
      isWatched: true,
      isWatchLater: true,
      progress: 42,
    });
    expect(readFeedHttp).toHaveBeenCalledTimes(kind === "rss" ? 1 : 0);
  },
);

it.each([true, false])(
  "ingests Atmosphere documents with image availability=%s",
  async (available) => {
    if (!available)
      vi.mocked(readFeedHttp).mockRejectedValue(
        new Error("Optional image unavailable"),
      );
    await useAtmosphere();
    vi.mocked(createPublicationClient).mockReturnValue({
      latestRev: async () => "new",
      resolvePds: async () => "https://pds.example.com",
      getDidDocument: async () => {
        throw new Error("Unexpected DID document");
      },
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
      loadBlob: async () => ({ bytes: new Uint8Array(), mimeType: null }),
    });
    await refresh();
    expect(await stored()).toMatchObject({
      thumbnail: available ? OG : "",
      sourceKind: "atproto",
    });
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toMatchObject([{ status: "ready" }]);
  },
);

it("composes cover, RSS media, page and body candidates in order", async () => {
  const rss = {
    ...observation(),
    thumbnail: "https://example.com/media.png",
    pageImageUrl: OG,
  };
  const document = {
    ...observation(),
    kind: "atproto" as const,
    key: "at://did:plc:alice/site.standard.document/post",
    thumbnail: "https://example.com/cover.png",
  };
  await writeEnriched([rss, document]);
  expect((await stored()).thumbnail).toBe(document.thumbnail);
  expect(readFeedHttp).not.toHaveBeenCalled();
  await writeEnriched([{ ...document, thumbnail: "" }]);
  expect((await stored()).thumbnail).toBe(rss.thumbnail);
  await writeEnriched([{ ...rss, thumbnail: "" }]);
  expect((await stored()).thumbnail).toBe(OG);
});

it("bounds optional page requests and concurrency within content ingestion", async () => {
  let active = 0;
  let maximum = 0;
  vi.mocked(readFeedHttp).mockImplementation(async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response(url, `<meta property="og:image" content="${OG}">`);
  });
  await writeEnriched(Array.from({ length: 20 }, (_, i) => observation(i)));
  expect(readFeedHttp).toHaveBeenCalledTimes(8);
  expect(maximum).toBeLessThanOrEqual(2);
  expect(
    (await fixture.database.select().from(feedItems)).filter(
      (item) => item.thumbnail === OG,
    ),
  ).toHaveLength(8);
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
  "keeps content and the body fallback after a %s image lookup",
  async (mode) => {
    vi.mocked(readFeedHttp).mockImplementation(async (url) => {
      if (mode === "failure") throw new Error("timeout");
      return response(url, "<p>No metadata</p>");
    });
    await writeEnriched([observation()]);
    expect(await stored()).toMatchObject({
      thumbnail: BODY,
      content: expect.stringContaining("Bookmarks"),
    });
    expect(readFeedHttp).toHaveBeenCalledTimes(1);
  },
);

it("resolves escaped relative OG metadata against the final redirected URL", async () => {
  vi.mocked(readFeedHttp).mockResolvedValue(
    response(
      "https://cdn.example.com/article/",
      '<meta content="javascript:alert(1)" property="og:image:secure_url"><meta content="../image.png?a=1&amp;b=2" property="og:image">',
    ),
  );
  await writeEnriched([observation()]);
  expect((await stored()).thumbnail).toBe(
    "https://cdn.example.com/image.png?a=1&b=2",
  );
});

it("does not reuse an RSS page image after a document changes the canonical URL", async () => {
  await writeEnriched([observation()]);
  await writeObservedItems(fixture.database, fetchable.feed, [
    {
      ...observation(),
      kind: "atproto",
      key: "at://did:plc:alice/site.standard.document/post",
    },
  ]);
  await writeObservedItems(fixture.database, fetchable.feed, [
    {
      ...observation(),
      kind: "atproto",
      key: "at://did:plc:alice/site.standard.document/post",
      url: "https://example.com/moved",
    },
  ]);
  expect(await stored()).toMatchObject({
    url: "https://example.com/moved",
    thumbnail: BODY,
  });
});

it("retains an observation's successful image when the other source updates", async () => {
  await writeEnriched([observation()]);
  await writeObservedItems(fixture.database, fetchable.feed, [
    {
      ...observation(),
      kind: "atproto",
      key: "at://did:plc:alice/site.standard.document/post",
    },
  ]);
  expect((await stored()).thumbnail).toBe(OG);
});
