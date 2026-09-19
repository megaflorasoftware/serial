import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import { recoverRepository } from "../jetstream/repository-recovery";
import type { HydratedFeedOrigin } from "~/server/db/schema";
import type { ItemObservation } from "~/server/rss/itemObservation";
import type { PublicationClient } from "~/server/rss/atprotoClient";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import { createPublicationClient } from "~/server/rss/atprotoClient";
import {
  feedItems,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feeds,
  user,
} from "~/server/db/schema";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { writeObservedItems } from "~/server/rss/writeItems";
import { rssObservation } from "~/server/rss/itemObservation";
import { logWarning } from "~/server/logger";

vi.mock("~/server/logger", () => ({
  logWarning: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const DID = "did:plc:alice";
const PUB = `at://${DID}/site.standard.publication/site`;
const uri = (rkey: string) => `at://${DID}/site.standard.document/${rkey}`;
const DATE = "2026-09-15T12:00:00Z";
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let feed: typeof feeds.$inferSelect;
let origin: HydratedFeedOrigin;
beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const created = await insertFeedWithOrigins(fixture.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Feed",
      platform: "website",
      imageUrl: "",
      origins: [{ kind: "atproto", locator: PUB }],
    },
  });
  feed = created;
  origin = created.origins[0]!;
});
afterEach(() => fixture.cleanup());

function rss(overrides: Partial<ItemObservation> = {}): ItemObservation {
  return {
    ...rssObservation({
      id: "rss-1",
      url: "https://example.com/post",
      title: "RSS title",
      author: "RSS author",
      publishedDate: DATE,
      content: "<p>RSS body</p><script>alert(1)</script>",
      contentSnippet: "RSS summary",
      thumbnail: "https://example.com/rss.jpg",
      tags: ["rss"],
    }),
    ...overrides,
  };
}
function document(overrides: Partial<ItemObservation> = {}): ItemObservation {
  return {
    kind: "atproto",
    key: uri("001"),
    url: "https://example.com/post",
    title: "Document title",
    author: "",
    publicationName: "Publication",
    description: "Document summary",
    thumbnail: "",
    content: "<p>Native body</p>",
    firstParagraph: "Native body",
    firstImageUrl: "https://example.com/body.jpg",
    publishedAt: DATE,
    tags: ["document"],
    ...overrides,
  };
}
function record(rkey: string, overrides = {}) {
  return {
    uri: uri(rkey),
    cid: `cid${rkey}`,
    value: {
      $type: "site.standard.document",
      title: rkey,
      site: PUB,
      path: `/${rkey}`,
      publishedAt: DATE,
      content: {
        $type: "pub.leaflet.content",
        pages: [
          {
            $type: "pub.leaflet.pages.linearDocument",
            blocks: [
              {
                block: {
                  $type: "pub.leaflet.blocks.text",
                  plaintext: `Body ${rkey}`,
                },
              },
            ],
          },
        ],
      },
      ...overrides,
    },
  };
}
function client(records: unknown[] = []): PublicationClient {
  return {
    resolvePds: vi.fn(async () => "https://pds.example.com"),
    latestRev: vi.fn(async () => "rev1"),
    getRecord: vi.fn(async () => ({
      uri: PUB,
      cid: "pubcid",
      value: {
        name: "Publication",
        url: "https://example.com",
        icon: { ref: { $link: "bafyicon" }, mimeType: "image/png" },
      },
    })),
    loadBlob: vi.fn(async () => new Uint8Array()),
    resolveRecord: vi.fn(async () => null),
    list: vi.fn(async () => ({
      records,
      notModified: false as const,
      cursor: undefined,
      etag: '"one"',
    })),
  };
}
async function refresh(remote: PublicationClient) {
  await recoverRepository(fixture.database, origin.id, {
    client: remote,
    readPage: async () => {
      throw new Error("Page unavailable");
    },
  });
}

describe("composite Feed items", () => {
  it.each([true, false])(
    "applies field precedence in either arrival order, document first=%s",
    async (first) => {
      for (const observation of first
        ? [document(), rss()]
        : [rss(), document()])
        await writeObservedItems(fixture.database, feed, [observation]);
      const items = await fixture.database.select().from(feedItems);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        title: "Document title",
        author: "RSS author",
        contentSnippet: "Document summary",
        content: "<p>Native body</p>",
        thumbnail: "https://example.com/rss.jpg",
        sourceKind: "both",
        bodySource: "atproto",
        tags: ["document", "rss"],
      });
      await writeObservedItems(fixture.database, feed, [
        document({ description: "", content: "", title: "", tags: [] }),
      ]);
      expect(
        await fixture.database.select().from(feedItems).get(),
      ).toMatchObject({
        id: items[0]!.id,
        title: "RSS title",
        contentSnippet: "RSS summary",
        content: "<p>RSS body</p>",
        bodySource: "rss",
        tags: ["rss"],
      });
    },
  );
  it("merges a URL collision and stale aliases without losing user state", async () => {
    const original = (
      await writeObservedItems(fixture.database, feed, [document()])
    ).items[0]!;
    const collision = (
      await writeObservedItems(fixture.database, feed, [
        rss({ key: "other", url: "https://example.com/new" }),
      ])
    ).items[0]!;
    await fixture.database
      .update(feedItems)
      .set({
        isWatchLater: true,
        isWatchLaterUpdatedAt: new Date("2026-09-15"),
        progress: 80,
      })
      .where(eq(feedItems.id, original.id));
    await fixture.database
      .update(feedItems)
      .set({
        isWatched: true,
        isWatchedUpdatedAt: new Date("2026-09-16"),
        progress: 50,
      })
      .where(eq(feedItems.id, collision.id));
    const result = await writeObservedItems(fixture.database, feed, [
      document({ url: "https://example.com/new" }),
    ]);
    expect(result.removedItemIds).toEqual([collision.id]);
    await writeObservedItems(fixture.database, feed, [
      rss(),
      rss({ key: "other", url: "https://example.com/new" }),
    ]);
    const items = await fixture.database.select().from(feedItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: original.id,
      url: "https://example.com/new",
      isWatchLater: true,
      isWatched: true,
      progress: 80,
    });
  });
  it("normalizes canonical URLs and leaves an unchanged composite untouched", async () => {
    const first = await writeObservedItems(fixture.database, feed, [
      rss({ url: "https://example.com/post" }),
    ]);
    expect(
      (await writeObservedItems(fixture.database, feed, [rss()])).items,
    ).toEqual([]);
    expect(
      (await fixture.database.select().from(feedItems).get())?.createdAt,
    ).toEqual(first.items[0]?.createdAt);
  });
});

describe("Atmosphere repository recovery", () => {
  it("converts documents and leaves unchanged items intact on another scan", async () => {
    const remote = client([
      record("003"),
      record("002", { site: `at://${DID}/pub.leaflet.publication/site` }),
    ]);
    await refresh(remote);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
    expect(await fixture.database.select().from(feeds).get()).toMatchObject({
      name: "Publication",
    });
    const items = await fixture.database.select().from(feedItems);
    await refresh(remote);
    expect(await fixture.database.select().from(feedItems)).toEqual(items);
    expect(remote.list).toHaveBeenCalledTimes(2);
  });
  it("processes edits after the known boundary on the entire first page", async () => {
    const remote = client([record("003"), record("002")]);
    await refresh(remote);
    remote.latestRev = vi.fn(async () => "rev2");
    remote.list = vi.fn(async () => ({
      records: [
        record("004"),
        record("003"),
        { ...record("002", { title: "Edited" }), cid: "edited" },
      ],
      cursor: "older",
      etag: null,
      notModified: false as const,
    }));
    await refresh(remote);
    expect(remote.list).toHaveBeenCalledTimes(1);
    expect(
      await fixture.database
        .select()
        .from(feedItems)
        .where(eq(feedItems.atprotoUri, uri("002")))
        .get(),
    ).toMatchObject({ title: "Edited" });
  });
  it("caps the initial import at 200 matching documents and tolerates unrelated publications", async () => {
    const remote = client();
    remote.list = vi.fn(async (_did, cursor) => ({
      records: Array.from({ length: 100 }, (_, i) =>
        record(String(999 - Number(cursor ?? 0) - i).padStart(3, "0")),
      ),
      cursor: String(Number(cursor ?? 0) + 100),
      etag: null,
      notModified: false as const,
    }));
    await refresh(remote);
    expect(remote.list).toHaveBeenCalledTimes(2);
    expect(
      await fixture.database.select().from(feedOriginAtprotoDocuments),
    ).toHaveLength(200);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(25);
    for (let batch = 0; batch < 7; batch++)
      await recoverRepository(
        fixture.database,
        origin.id,
        {
          client: remote,
          manual: false,
          readPage: async () => {
            throw new Error("Page unavailable");
          },
        },
        false,
      );
    expect(remote.list).toHaveBeenCalledTimes(2);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(200);
    expect(
      await fixture.database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.status, "retry")),
    ).toHaveLength(0);
  });
  it("keeps successes and retries a failed body after it leaves the first page", async () => {
    const broken = record("002", {
      content: {
        $type: "pub.leaflet.content",
        blobPages: { ref: { $link: "bafybody" } },
      },
    });
    const remote = client([record("003"), broken]);
    remote.loadBlob = vi.fn(async () => {
      throw new Error("temporary");
    });
    await refresh(remote);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
    expect(
      await fixture.database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.uri, broken.uri))
        .get(),
    ).toMatchObject({ status: "retry", pendingRecord: broken.value });
    remote.list = vi.fn(async () => ({
      records: [record("003")],
      etag: null,
      notModified: false as const,
      cursor: undefined,
    }));
    remote.loadBlob = vi.fn(async () =>
      new TextEncoder().encode(
        JSON.stringify({ pages: record("002").value.content.pages }),
      ),
    );
    await fixture.database
      .update(feedOriginAtprotoDocuments)
      .set({ retryAt: null });
    await refresh(remote);
    expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
    expect(
      await fixture.database
        .select()
        .from(feedOriginAtprotoDocuments)
        .where(eq(feedOriginAtprotoDocuments.status, "retry")),
    ).toHaveLength(0);
  });
  it("retains a renamed Feed and does not use plaintext as its article body", async () => {
    await fixture.database
      .update(feeds)
      .set({ name: "Mine", nameEditedAt: new Date() })
      .where(eq(feeds.id, feed.id));
    await refresh(
      client([
        record("001", { content: undefined, textContent: "Only plaintext" }),
      ]),
    );
    expect(await fixture.database.select().from(feeds).get()).toMatchObject({
      name: "Mine",
    });
    expect(await fixture.database.select().from(feedItems).get()).toMatchObject(
      { content: "", bodySource: "none" },
    );
  });
  it("bounds sparse repo scans and saves a continuation cursor", async () => {
    const remote = client();
    remote.list = vi.fn(async (_did, cursor) => ({
      records: [
        record(String(999 - Number(cursor ?? 0)), {
          site: `at://${DID}/site.standard.publication/other`,
        }),
      ],
      cursor: String(Number(cursor ?? 0) + 1),
      etag: null,
      notModified: false as const,
    }));
    await refresh(remote);
    expect(remote.list).toHaveBeenCalledTimes(10);
    expect(
      await fixture.database.select().from(feedOriginAtproto).get(),
    ).toMatchObject({ cursor: "10", initialized: false });
    await refresh(remote);
    expect(remote.list).toHaveBeenNthCalledWith(12, DID, "10", null);
  });
});

it("continues past a deleted boundary until it encounters a known document", async () => {
  await refresh(client([record("300"), record("100")]));
  const remote = client();
  remote.latestRev = vi.fn(async () => "rev2");
  remote.list = vi.fn(async (_did, cursor) => ({
    records: cursor ? [record("100")] : [record("250"), record("200")],
    cursor: cursor ? "older" : "next",
    etag: null,
    notModified: false as const,
  }));
  await refresh(remote);
  expect(remote.list).toHaveBeenCalledTimes(2);
  expect(await fixture.database.select().from(feedItems)).toHaveLength(4);
});

it("logs malformed listed-record envelopes without exposing their contents", async () => {
  vi.mocked(logWarning).mockClear();
  await refresh(
    client([
      { uri: uri("001"), value: { private: "do not log" } },
      { uri: "not-an-at-uri", cid: "cid", value: {} },
    ]),
  );
  expect(logWarning).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(logWarning).mock.calls)).not.toContain(
    "do not log",
  );
});

function linkedDocument(rkey: string, count: number) {
  return record(rkey, {
    content: {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: Array.from({ length: count }, (_, i) => ({
            block: {
              $type: "pub.leaflet.blocks.standardSitePublication",
              uri: `at://${DID}/site.standard.publication/ref${rkey}-${i}`,
            },
          })),
        },
      ],
    },
  });
}

function resolvingClient(
  documents: Array<ReturnType<typeof record>>,
  failReference = false,
) {
  documents = documents.map((document) => ({
    ...document,
    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }));
  const publication = {
    uri: PUB,
    cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    value: { name: "Publication", url: "https://example.com" },
  };
  const transport = createPublicationClient({
    resolvePds: async () => "https://pds.example.com",
    fetch: vi.fn(async (input) => {
      const url = new URL(String(input));
      const key = `at://${url.searchParams.get("repo")}/${url.searchParams.get("collection")}/${url.searchParams.get("rkey")}`;
      if (key.includes("/ref")) {
        return failReference
          ? new Response("temporary", { status: 503 })
          : Response.json({ ...publication, uri: key });
      }
      return Response.json(
        key === PUB ? publication : documents.find((doc) => doc.uri === key),
      );
    }),
  });
  return {
    ...client(documents),
    ...transport,
    latestRev: async () => "rev1",
    list: client(documents).list,
  };
}

it("imports the article with a fallback card when an embedded lookup fails", async () => {
  const documents = [linkedDocument("001", 1)];
  await refresh(resolvingClient(documents, true));
  const items = await fixture.database.select().from(feedItems);
  expect(items).toHaveLength(1);
  expect(items[0]?.content).toContain('data-size="row"');
  expect(items[0]?.content).toContain(
    `href="https://pdsls.dev/at://${DID}/site.standard.publication/ref001-0"`,
  );
  expect(
    await fixture.database
      .select()
      .from(feedOriginAtprotoDocuments)
      .where(eq(feedOriginAtprotoDocuments.status, "retry")),
  ).toHaveLength(0);
});

it("imports documents beyond the refresh reference budget using fallback cards", async () => {
  const documents = Array.from({ length: 8 }, (_, i) =>
    linkedDocument(String(100 - i), 16),
  );
  await refresh(resolvingClient(documents));
  const items = await fixture.database.select().from(feedItems);
  expect(items).toHaveLength(8);
  expect(
    items.filter((item) =>
      item.content?.includes('href="https://example.com/"'),
    ),
  ).toHaveLength(4);
  expect(
    items.filter((item) => item.content?.includes('href="https://pdsls.dev/')),
  ).toHaveLength(4);
  expect(
    await fixture.database
      .select()
      .from(feedOriginAtprotoDocuments)
      .where(eq(feedOriginAtprotoDocuments.status, "retry")),
  ).toHaveLength(0);
});

it("combines concurrent RSS and document writes into one item", async () => {
  await Promise.all([
    writeObservedItems(fixture.database, feed, [rss()]),
    writeObservedItems(fixture.database, feed, [document()]),
  ]);
  expect(await fixture.database.select().from(feedItems)).toMatchObject([
    { sourceKind: "both", bodySource: "atproto" },
  ]);
});

it("retains a persisted loser's historical aliases when a batch creates the winner", async () => {
  const olderKey = uri("older");
  await writeObservedItems(fixture.database, feed, [
    document({ key: olderKey, url: "https://example.com/old" }),
  ]);
  await writeObservedItems(fixture.database, feed, [
    document({ key: olderKey, url: "https://example.com/new" }),
  ]);
  const written = await writeObservedItems(fixture.database, feed, [
    document(),
    document({ url: "https://example.com/new" }),
  ]);
  expect(written.removedItemIds).toHaveLength(1);
  await writeObservedItems(fixture.database, feed, [
    rss({ key: "different", url: "https://example.com/old" }),
  ]);
  expect(await fixture.database.select().from(feedItems)).toMatchObject([
    {
      id: written.items[0]!.id,
      sourceKind: "both",
      url: "https://example.com/new",
    },
  ]);
});

it("continues queued origin writes after a failed transaction", async () => {
  await fixture.client.execute(`CREATE TRIGGER reject_rss_item
    BEFORE INSERT ON serial_feed_item WHEN NEW.source_kind = 'rss'
    BEGIN SELECT RAISE(ABORT, 'test RSS write failure'); END`);
  const results = await Promise.allSettled([
    writeObservedItems(fixture.database, feed, [rss()]),
    writeObservedItems(fixture.database, feed, [document()]),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(await fixture.database.select().from(feedItems)).toMatchObject([
    { sourceKind: "atproto", bodySource: "atproto" },
  ]);
});

it("commits items and bookkeeping for concurrent publication refreshes", async () => {
  const secondPublication = PUB + "2";
  const secondFeed = await insertFeedWithOrigins(fixture.database, {
    userId: "reader",
    isActive: true,
    details: {
      name: "Second",
      imageUrl: "",
      platform: "website",
      origins: [{ kind: "atproto", locator: secondPublication }],
    },
  });
  const secondOrigin = secondFeed.origins[0]!;
  const remote = client([record("001", { site: secondPublication })]);
  remote.getRecord = vi.fn(async () => ({
    uri: secondPublication,
    cid: "pubcid",
    value: { name: "Second", url: "https://second.example.com" },
  }));
  await Promise.all([
    refresh(client([record("001")])),
    recoverRepository(fixture.database, secondOrigin.id, {
      client: remote,
      readPage: async () => {
        throw new Error("Page unavailable");
      },
    }),
  ]);
  expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
  expect(await fixture.database.select().from(feedOriginAtproto)).toMatchObject(
    [{ initialized: true }, { initialized: true }],
  );
});

it("keeps remote database writers concurrent", async () => {
  const database = { $client: { protocol: "http" } };
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const first = runDatabaseWrite(database, async () => {
    started.push("first");
    await blocked;
  });
  const second = runDatabaseWrite(database, async () => {
    started.push("second");
  });
  try {
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
  } finally {
    release();
    await Promise.all([first, second]);
  }
});
