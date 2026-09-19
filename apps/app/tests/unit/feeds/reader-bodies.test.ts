import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bytesToBase64, stringifyLosslessJson } from "@serial/standard-site";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { ReaderBody } from "@serial/standard-site";
import type { PublicationClient } from "~/server/rss/atprotoClient";
import {
  atprotoReferenceSnapshots,
  feedItems,
  feedOriginAtprotoDocuments,
  user,
} from "~/server/db/schema";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  capReaderBodies,
  loadCappedReaderBodies,
  loadReaderBodies,
  ownedBodyRow,
  refreshDocumentReferences,
  toApplicationFeedItem,
} from "~/server/feeds/reader-bodies";
import { sweepReferenceSnapshots } from "~/server/jetstream/reference-snapshots";
import {
  stageDocumentSource,
  storeDocumentBlobs,
} from "~/server/jetstream/document-source";

vi.mock("~/server/logger", () => ({
  logWarning: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const DID = "did:plc:alice";
const PUB = `at://${DID}/site.standard.publication/site`;
const OTHER_PUB = `at://did:plc:bob/site.standard.publication/site`;
const DOC = `at://${DID}/site.standard.document/post`;
const REF = `at://did:plc:bob/site.standard.document/other`;
const NOW = new Date("2026-09-19T12:00:00Z");
const CID = "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CID_B = `${CID.slice(0, 10)}b${CID.slice(11)}`;

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
let feedId: number;
let originId: number;

function record(views: bigint | number = 1) {
  return stringifyLosslessJson({
    $type: "site.standard.document",
    site: PUB,
    title: "Post",
    path: "/post",
    publishedAt: NOW.toISOString(),
    views,
    content: {
      $type: "pub.leaflet.content",
      pages: [
        {
          $type: "pub.leaflet.pages.linearDocument",
          blocks: [
            {
              block: { $type: "pub.leaflet.blocks.text", plaintext: "Hello" },
            },
            {
              block: { $type: "pub.leaflet.blocks.standardSitePost", uri: REF },
            },
          ],
        },
      ],
    },
  });
}

async function insertItem(input: {
  id: string;
  content?: string;
  atprotoUri?: string | null;
  sourceCid?: string | null;
}) {
  await fixture.database.insert(feedItems).values({
    id: input.id,
    feedId,
    contentId: input.id,
    title: input.id,
    author: "",
    url: `https://example.com/${input.id}`,
    content: input.content ?? "",
    contentHash: `hash-${input.id}`,
    postedAt: NOW,
    atprotoUri: input.atprotoUri ?? null,
    sourceCid: input.sourceCid ?? null,
    bodySource: input.content ? "rss" : "none",
  });
}

async function retainSource(cid: string, text: string, withBlob = false) {
  await fixture.database
    .insert(feedOriginAtprotoDocuments)
    .values({ originId, uri: DOC, cid, status: "ready", bodyCid: cid })
    .onConflictDoUpdate({
      target: [
        feedOriginAtprotoDocuments.originId,
        feedOriginAtprotoDocuments.uri,
      ],
      set: { cid, bodyCid: cid },
    });
  await stageDocumentSource(
    fixture.database,
    { originId, uri: DOC, cid },
    text,
    NOW,
  );
  if (withBlob)
    await storeDocumentBlobs(fixture.database, { originId, uri: DOC, cid }, [
      {
        cid: "bafyblob",
        mimeType: "application/json",
        bytes: new Uint8Array([1, 2, 3]),
      },
    ]);
}

async function snapshot(uri: string, value: unknown, resolvedAt = NOW) {
  await fixture.database.insert(atprotoReferenceSnapshots).values({
    uri,
    cid: CID_B,
    outcome: "resolved",
    record: stringifyLosslessJson(value),
    resolvedAt,
    readAt: null,
  });
}

const referenced = {
  $type: "site.standard.document",
  site: OTHER_PUB,
  title: "Other",
  path: "/other",
  publishedAt: NOW.toISOString(),
};
const otherPublication = { name: "Bob", url: "https://bob.example.com" };

beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values({
    id: "reader",
    name: "Reader",
    email: "reader@example.com",
    emailVerified: true,
    createdAt: NOW,
    updatedAt: NOW,
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
  feedId = created.id;
  originId = created.origins[0]!.id;
});
afterEach(() => fixture.cleanup());

describe("reader bodies", () => {
  it("serves html bodies for RSS items and nothing for body-less items", async () => {
    await insertItem({ id: "rss", content: "<p>Body</p>" });
    await insertItem({ id: "empty" });
    const rows = await fixture.database.select().from(feedItems);
    const bodies = await loadReaderBodies(fixture.database, rows, NOW);
    expect(bodies.get("rss")).toEqual({
      form: "html",
      html: "<p>Body</p>",
      revision: "hash-rss",
    });
    expect(bodies.get("empty")).toBeNull();
    const item = toApplicationFeedItem(rows[0]!, "website", bodies.get("rss"));
    expect(item).not.toHaveProperty("content");
    expect(item.body?.form).toBe("html");
  });

  it("serves the retained source, its blobs and ordered snapshots with digits intact", async () => {
    await retainSource(CID, record(9007199254740993n), true);
    await insertItem({ id: "doc", atprotoUri: DOC, sourceCid: CID });
    await snapshot(REF, referenced);
    await snapshot(OTHER_PUB, otherPublication);
    const rows = await fixture.database.select().from(feedItems);
    const body = (await loadReaderBodies(fixture.database, rows, NOW)).get(
      "doc",
    );
    expect(body?.form).toBe("source");
    if (body?.form !== "source") throw new Error();
    expect(body.revision).toBe(CID);
    expect(body.source.record).toContain('"views":9007199254740993');
    expect(body.source.blobs).toEqual([
      {
        cid: "bafyblob",
        mimeType: "application/json",
        bytes: bytesToBase64(new Uint8Array([1, 2, 3])),
      },
    ]);
    expect(body.references.map((reference) => reference.uri)).toEqual([
      REF,
      OTHER_PUB,
    ]);
    expect(body.references[0]).toMatchObject({
      outcome: "resolved",
      cid: CID_B,
    });
    const read = await fixture.database
      .select()
      .from(atprotoReferenceSnapshots);
    expect(read.every((row) => row.readAt?.getTime() === NOW.getTime())).toBe(
      true,
    );
  });

  it("falls back to the html body when the item names a source that is gone", async () => {
    await insertItem({
      id: "doc",
      content: "<p>RSS</p>",
      atprotoUri: DOC,
      sourceCid: CID,
    });
    const rows = await fixture.database.select().from(feedItems);
    const body = (await loadReaderBodies(fixture.database, rows, NOW)).get(
      "doc",
    );
    expect(body).toEqual({
      form: "html",
      html: "<p>RSS</p>",
      revision: "hash-doc",
    });
  });

  it("caps responses in request order and names the omitted ids", () => {
    const body = (size: number): ReaderBody => ({
      form: "html",
      html: "x".repeat(size),
      revision: "r",
    });
    const entries = [
      { id: "a", body: body(60) },
      { id: "b", body: null },
      { id: "c", body: body(50) },
      { id: "d", body: body(10) },
    ];
    const { items, omitted } = capReaderBodies(entries, 100);
    expect(items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(omitted.map((entry) => entry.id)).toEqual(["c", "d"]);
    // A single oversized body still ships rather than starving the request.
    expect(
      capReaderBodies([{ id: "big", body: body(500) }], 100).items,
    ).toHaveLength(1);
  });

  it("refreshes stale snapshots at their latest version and keeps young ones", async () => {
    await retainSource(CID, record());
    await insertItem({ id: "doc", atprotoUri: DOC, sourceCid: CID });
    const old = new Date(NOW.getTime() - 16 * 60_000);
    await snapshot(REF, { ...referenced, title: "Stale" }, old);
    const getRecord = vi.fn(async (uri: string) => ({
      uri,
      cid: uri === REF ? CID_B : CID,
      value: uri === REF ? referenced : otherPublication,
    }));
    const client = { getRecord } as unknown as PublicationClient;
    const row = (await ownedBodyRow(fixture.database, "reader", "doc"))!;
    const result = await refreshDocumentReferences(fixture.database, row, {
      now: NOW,
      client,
    });
    expect(result?.revision).toBe(CID);
    expect(result?.references.map((reference) => reference.uri)).toEqual([
      REF,
      OTHER_PUB,
    ]);
    // Same CID: the stored record is kept, only the time moves forward.
    expect(result?.references[0]?.record).toContain("Stale");
    expect(result?.references[0]?.resolvedAt).toBe(NOW.toISOString());
    expect(getRecord).toHaveBeenCalledTimes(2);
    getRecord.mockClear();
    const again = await refreshDocumentReferences(fixture.database, row, {
      now: new Date(NOW.getTime() + 60_000),
      client,
    });
    expect(getRecord).not.toHaveBeenCalled();
    expect(again?.references).toHaveLength(2);
  });

  it("records unavailable lookups without discarding the saved snapshot", async () => {
    await retainSource(CID, record());
    await insertItem({ id: "doc", atprotoUri: DOC, sourceCid: CID });
    await snapshot(REF, referenced, new Date(NOW.getTime() - 60 * 60_000));
    const client = {
      getRecord: vi.fn(async () => {
        throw new Error("503");
      }),
    } as unknown as PublicationClient;
    const row = (await ownedBodyRow(fixture.database, "reader", "doc"))!;
    const result = await refreshDocumentReferences(fixture.database, row, {
      now: NOW,
      client,
    });
    expect(result?.references).toEqual([
      expect.objectContaining({
        uri: REF,
        outcome: "unavailable",
        record: null,
      }),
    ]);
    expect(
      await fixture.database
        .select()
        .from(atprotoReferenceSnapshots)
        .where(eq(atprotoReferenceSnapshots.uri, REF))
        .get(),
    ).toMatchObject({ outcome: "unavailable" });
  });

  it("sweeps snapshots unread for the retention window, however fresh", async () => {
    const day = 24 * 60 * 60_000;
    await snapshot(REF, referenced, NOW);
    await snapshot(OTHER_PUB, otherPublication, NOW);
    await fixture.database
      .update(atprotoReferenceSnapshots)
      .set({ readAt: new Date(NOW.getTime() - 91 * day) })
      .where(eq(atprotoReferenceSnapshots.uri, REF));
    await fixture.database
      .update(atprotoReferenceSnapshots)
      .set({ readAt: new Date(NOW.getTime() - 89 * day) })
      .where(eq(atprotoReferenceSnapshots.uri, OTHER_PUB));
    await sweepReferenceSnapshots(fixture.database, NOW);
    expect(
      (await fixture.database.select().from(atprotoReferenceSnapshots)).map(
        (row) => row.uri,
      ),
    ).toEqual([OTHER_PUB]);
  });

  it("loads bodies slice by slice and stops at the first slice over budget", async () => {
    for (let index = 0; index < 60; index++)
      // Sequential inserts keep ids ordered for the request below.
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
      await insertItem({
        id: `rss-${String(index).padStart(2, "0")}`,
        content: `<p>${"x".repeat(1000)}</p>`,
      });
    const rows = (await fixture.database.select().from(feedItems)).sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    const { items, omitted } = await loadCappedReaderBodies(
      fixture.database,
      rows,
      NOW,
    );
    expect(items).toHaveLength(60);
    expect(omitted).toEqual([]);
  });

  it("returns null for items without a source and for other users' items", async () => {
    await insertItem({ id: "rss", content: "<p>Body</p>" });
    const row = (await ownedBodyRow(fixture.database, "reader", "rss"))!;
    expect(
      await refreshDocumentReferences(fixture.database, row, { now: NOW }),
    ).toBeNull();
    expect(
      await ownedBodyRow(fixture.database, "someone-else", "rss"),
    ).toBeUndefined();
  });
});
