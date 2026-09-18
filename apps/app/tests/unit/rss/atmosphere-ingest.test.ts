import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { ItemObservation } from "~/server/rss/itemObservation";
import type { PublicationClient } from "~/server/rss/atprotoClient";
import {
  createPublicationClient,
  MissingPublicationRecordError,
} from "~/server/rss/atprotoClient";
import {
  feedDocumentRecords,
  feedIngestState,
  feedItems,
  feedOrigins,
  feeds,
  user,
} from "~/server/db/schema";
import { runDatabaseWrite } from "~/server/db/retry-write";
import { writeObservedItems } from "~/server/rss/writeItems";
import { rssObservation } from "~/server/rss/itemObservation";
import { ingestAtmosphere } from "~/server/rss/ingestAtmosphere";
import { logWarning } from "~/server/logger";

vi.mock("~/server/logger", () => ({ logWarning: vi.fn() }));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const DID = "did:plc:alice";
const PUB = `at://${DID}/site.standard.publication/site`;
const uri = (rkey: string) => `at://${DID}/site.standard.document/${rkey}`;
const DATE = "2026-09-15T12:00:00Z";
let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let feed: typeof feeds.$inferSelect;
let origin: typeof feedOrigins.$inferSelect;
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
  [feed] = (await fixture.database
    .insert(feeds)
    .values({
      userId: "reader",
      name: "Feed",
      platform: "website",
      imageUrl: "",
      isActive: true,
    })
    .returning()) as [typeof feed];
  [origin] = (await fixture.database
    .insert(feedOrigins)
    .values({
      feedId: feed.id,
      userId: "reader",
      kind: "atproto",
      locator: PUB,
    })
    .returning()) as [typeof origin];
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
  origin = (await fixture.database
    .select()
    .from(feedOrigins)
    .where(eq(feedOrigins.id, origin.id))
    .get())!;
  feed = (await fixture.database
    .select()
    .from(feeds)
    .where(eq(feeds.id, feed.id))
    .get())!;
  return ingestAtmosphere(fixture.database, { feed, origin }, remote);
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

describe("Atmosphere polling", () => {
  it("converts documents and skips an unchanged repo revision", async () => {
    const remote = client([
      record("003"),
      record("002", { site: `at://${DID}/pub.leaflet.publication/site` }),
    ]);
    const result = await refresh(remote);
    expect(result.status).toBe("success");
    expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
    expect(await fixture.database.select().from(feeds).get()).toMatchObject({
      name: "Publication",
    });
    expect((await refresh(remote)).status).toBe("skipped");
    expect(remote.list).toHaveBeenCalledTimes(1);
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
    expect(await fixture.database.select().from(feedItems)).toHaveLength(200);
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
    expect((await refresh(remote)).status).toBe("error");
    expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
    expect(
      await fixture.database.select().from(feedOrigins).get(),
    ).toMatchObject({ repoRev: null });
    remote.list = vi.fn(async () => ({
      records: [record("003")],
      etag: null,
      notModified: false as const,
      cursor: undefined,
    }));
    const originalGet = remote.getRecord;
    remote.getRecord = vi.fn(async (key) =>
      key === broken.uri ? record("002") : originalGet(key),
    );
    expect((await refresh(remote)).status).toBe("success");
    expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
    expect(
      await fixture.database
        .select()
        .from(feedDocumentRecords)
        .where(eq(feedDocumentRecords.status, "retry")),
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
      await fixture.database.select().from(feedIngestState).get(),
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

it("stops retrying a deleted document while preserving its stored item", async () => {
  await refresh(client([record("001")]));
  await fixture.database.update(feedDocumentRecords).set({ status: "retry" });
  const remote = client();
  const originalGet = remote.getRecord;
  remote.getRecord = vi.fn(async (key) => {
    if (key === uri("001")) throw new MissingPublicationRecordError("gone");
    return originalGet(key);
  });
  expect((await refresh(remote)).status).toBe("empty");
  expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
  expect(
    await fixture.database.select().from(feedDocumentRecords).get(),
  ).toMatchObject({ status: "invalid" });
  expect((await refresh(remote)).status).toBe("skipped");
});

it("stops retrying an invalid fetched envelope while preserving its stored item", async () => {
  await refresh(client([record("001")]));
  await fixture.database.update(feedDocumentRecords).set({ status: "retry" });
  const remote = client([]);
  remote.getRecord = vi.fn(async (key) =>
    key === uri("001")
      ? { uri: key, value: { title: "missing cid" } }
      : {
          uri: PUB,
          cid: "pubcid",
          value: { name: "Publication", url: "https://example.com" },
        },
  );
  expect((await refresh(remote)).status).toBe("empty");
  expect(
    await fixture.database.select().from(feedDocumentRecords).get(),
  ).toMatchObject({ status: "invalid" });
  expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
});

it("retires a retry that moved to another publication", async () => {
  await refresh(client([record("001")]));
  await fixture.database.update(feedDocumentRecords).set({ status: "retry" });
  const remote = client([]);
  remote.latestRev = vi.fn(async () => "rev2");
  const originalGet = remote.getRecord;
  remote.getRecord = vi.fn(async (key) =>
    key === uri("001")
      ? record("001", {
          site: `at://${DID}/site.standard.publication/elsewhere`,
        })
      : originalGet(key),
  );
  expect((await refresh(remote)).status).toBe("empty");
  expect(
    await fixture.database.select().from(feedDocumentRecords).get(),
  ).toMatchObject({ status: "invalid" });
  expect(await fixture.database.select().from(feedOrigins).get()).toMatchObject(
    {
      repoRev: "rev2",
    },
  );
});

it("rotates bounded retry batches so later records are not starved", async () => {
  await fixture.database.insert(feedDocumentRecords).values(
    Array.from({ length: 101 }, (_, index) => {
      const rkey = String(index).padStart(3, "0");
      return {
        originId: origin.id,
        uri: uri(rkey),
        cid: `cid${rkey}`,
        status: "retry" as const,
      };
    }),
  );
  const remote = client([]);
  const originalGet = remote.getRecord;
  remote.getRecord = vi.fn(async (key) => {
    if (key === PUB) return originalGet(key);
    throw new Error("temporary");
  });
  await refresh(remote);
  expect(remote.getRecord).toHaveBeenCalledTimes(101);
  expect(remote.getRecord).not.toHaveBeenCalledWith(uri("100"));
  vi.mocked(remote.getRecord).mockClear();
  await refresh(remote);
  expect(remote.getRecord).toHaveBeenCalledTimes(101);
  expect(remote.getRecord).toHaveBeenCalledWith(uri("100"));
  const plan = await fixture.client.execute({
    sql: "EXPLAIN QUERY PLAN SELECT * FROM serial_feed_document_record WHERE origin_id = ? AND status = ? AND uri > ? ORDER BY uri LIMIT 100",
    args: [origin.id, "retry", uri("050")],
  });
  expect(plan.rows.map((row) => String(row.detail)).join("\n")).toContain(
    "feed_document_retry_idx",
  );
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

it("omits an earlier retry result that a later listed document replaces", async () => {
  await refresh(client([record("002", { path: "/two" }), record("001")]));
  await fixture.database
    .update(feedDocumentRecords)
    .set({ status: "retry" })
    .where(eq(feedDocumentRecords.uri, uri("001")));
  const remote = client([
    { ...record("002", { path: "/shared" }), cid: "edited-two" },
  ]);
  remote.latestRev = vi.fn(async () => "rev2");
  const originalGet = remote.getRecord;
  remote.getRecord = vi.fn(async (key) =>
    key === uri("001")
      ? { ...record("001", { path: "/shared" }), cid: "edited-one" }
      : originalGet(key),
  );
  const result = await refresh(remote);
  if (result.status === "skipped") throw new Error("Expected refresh work");
  expect(result.removedItemIds).toHaveLength(1);
  expect(result.feedItems?.map((item) => item.id)).not.toContain(
    result.removedItemIds[0],
  );
  expect(await fixture.database.select().from(feedItems)).toHaveLength(1);
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

it("retries temporary embedded-link failures and then stores the canonical card", async () => {
  const documents = [linkedDocument("001", 1)];
  expect((await refresh(resolvingClient(documents, true))).status).toBe(
    "error",
  );
  expect(await fixture.database.select().from(feedItems)).toHaveLength(0);
  expect((await refresh(resolvingClient(documents))).status).toBe("success");
  expect(
    (await fixture.database.select().from(feedItems).get())?.content,
  ).toContain('href="https://example.com/"');
  expect((await refresh(resolvingClient(documents))).status).toBe("skipped");
});

it("eventually completes documents that exceed the refresh reference budget", async () => {
  const documents = Array.from({ length: 8 }, (_, i) =>
    linkedDocument(String(100 - i), 16),
  );
  expect((await refresh(resolvingClient(documents))).status).toBe("error");
  expect(await fixture.database.select().from(feedItems)).toHaveLength(4);
  expect((await refresh(resolvingClient(documents))).status).toBe("success");
  expect(await fixture.database.select().from(feedItems)).toHaveLength(8);
  expect(
    await fixture.database
      .select()
      .from(feedDocumentRecords)
      .where(eq(feedDocumentRecords.status, "retry")),
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
  const [secondFeed] = await fixture.database
    .insert(feeds)
    .values({
      userId: "reader",
      name: "Second",
      imageUrl: "",
      platform: "website",
      isActive: true,
    })
    .returning();
  const secondPublication = PUB + "2";
  const [secondOrigin] = await fixture.database
    .insert(feedOrigins)
    .values({
      userId: "reader",
      feedId: secondFeed!.id,
      kind: "atproto",
      locator: secondPublication,
    })
    .returning();
  const remote = client([record("001", { site: secondPublication })]);
  remote.getRecord = vi.fn(async () => ({
    uri: secondPublication,
    cid: "pubcid",
    value: { name: "Second", url: "https://second.example.com" },
  }));
  const results = await Promise.all([
    refresh(client([record("001")])),
    ingestAtmosphere(
      fixture.database,
      { feed: secondFeed!, origin: secondOrigin! },
      remote,
    ),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "success",
    "success",
  ]);
  expect(await fixture.database.select().from(feedItems)).toHaveLength(2);
  expect(await fixture.database.select().from(feedOrigins)).toMatchObject([
    { repoRev: "rev1" },
    { repoRev: "rev1" },
  ]);
  expect(await fixture.database.select().from(feedIngestState)).toMatchObject([
    { initialized: true },
    { initialized: true },
  ]);
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
