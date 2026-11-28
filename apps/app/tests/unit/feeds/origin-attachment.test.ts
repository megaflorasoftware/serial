import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createLocalBenchmarkTarget,
  openBenchmarkDatabase,
} from "../../../scripts/performance/database";
import {
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feedOriginRss,
  feedOrigins,
  feeds,
  feedsSchema,
  user,
} from "~/server/db/schema";
import {
  attachMissingFeedOrigins,
  FEED_ORIGIN_CONFLICT,
  findFeedForOrigins,
  insertFeedWithOrigins,
  loadOriginsForFeeds,
} from "~/server/feeds/origins";
import { newRssFeedDetails } from "~/server/rss/types";

let target: ReturnType<typeof createLocalBenchmarkTarget>;
let session: ReturnType<typeof openBenchmarkDatabase>;
const rss = { kind: "rss", locator: "https://example.com/rss" };
const atmosphere = {
  kind: "atproto",
  locator: "at://did:plc:example/site.standard.publication/one",
};
beforeEach(async () => {
  target = createLocalBenchmarkTarget();
  session = openBenchmarkDatabase({ url: target.url });
  await applyMigrations(session.baseClient);
  await session.database.insert(user).values(
    ["owner", "other"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
});
afterEach(() => {
  session.close();
  target.cleanup();
});

async function seed(userId = "owner", locator = rss.locator) {
  return insertFeedWithOrigins(session.database, {
    userId,
    isActive: false,
    details: {
      ...newRssFeedDetails({
        url: locator,
        name: "My custom name",
        platform: "website",
      }),
      nameEditedAt: new Date("2026-09-01"),
    },
  });
}
describe("Feed origin attachment", () => {
  it("attaches an origin while preserving the existing inactive Feed, with bounded queries", async () => {
    const original = await seed();
    await seed("other");
    session.instrumentation.reset();
    const result = await session.database.transaction(async (database) => {
      const match = await findFeedForOrigins(database, "owner", [
        rss,
        atmosphere,
      ]);
      expect(match?.id).toBe(original.id);
      return attachMissingFeedOrigins(database, match!, [rss, atmosphere]);
    });
    const evidence = session.instrumentation.snapshot();
    expect(evidence.statementCount).toBeLessThanOrEqual(7);
    expect(evidence.materializedRows).toBeLessThanOrEqual(4);
    expect(result).toMatchObject({
      id: original.id,
      name: original.name,
      isActive: false,
      nameEditedAt: original.nameEditedAt,
      openLocation: original.openLocation,
    });
    expect(result.origins.map((origin) => origin.kind)).toEqual([
      "rss",
      "atproto",
    ]);
    expect(await session.database.select().from(feeds)).toHaveLength(2);
    const repeated = await findFeedForOrigins(session.database, "owner", [
      rss,
      atmosphere,
    ]);
    expect(
      await attachMissingFeedOrigins(session.database, repeated!, [
        rss,
        atmosphere,
      ]),
    ).toEqual(repeated);
  });
  it("rejects origins on different Feeds without changes", async () => {
    await seed();
    await insertFeedWithOrigins(session.database, {
      userId: "owner",
      isActive: true,
      details: { name: "Other", platform: "website", origins: [atmosphere] },
    });
    await expect(
      findFeedForOrigins(session.database, "owner", [rss, atmosphere]),
    ).rejects.toThrow(FEED_ORIGIN_CONFLICT);
    expect(await session.database.select().from(feedOrigins)).toHaveLength(2);
  });
  it("rejects replacing an existing origin of the same kind", async () => {
    const existing = await seed();
    await attachMissingFeedOrigins(session.database, existing, [atmosphere]);
    await expect(
      findFeedForOrigins(session.database, "owner", [
        rss,
        { ...atmosphere, locator: `${atmosphere.locator}-different` },
      ]),
    ).rejects.toThrow(FEED_ORIGIN_CONFLICT);
    expect(await session.database.select().from(feedOrigins)).toHaveLength(2);
  });
  it("reuses a verified alternate while preserving the stored RSS locator", async () => {
    const original = await seed("owner", "https://example.com/atom.xml");
    session.instrumentation.reset();
    const result = await session.database.transaction(async (database) => {
      const match = await findFeedForOrigins(database, "owner", [
        {
          kind: "rss",
          locator: rss.locator,
          alternateLocators: ["https://example.com/atom.xml"],
        },
        atmosphere,
      ]);
      return attachMissingFeedOrigins(database, match!, [rss, atmosphere]);
    });
    const evidence = session.instrumentation.snapshot();
    expect(evidence.statementCount).toBeLessThanOrEqual(7);
    expect(evidence.materializedRows).toBeLessThanOrEqual(4);
    expect(result).toMatchObject({
      id: original.id,
      name: original.name,
      isActive: original.isActive,
      openLocation: original.openLocation,
    });
    expect(
      result.origins.find((origin) => origin.kind === "rss")?.locator,
    ).toBe("https://example.com/atom.xml");
    expect(await session.database.select().from(feeds)).toHaveLength(1);
  });
  it("rejects verified alternate locators that resolve to different Feeds", async () => {
    await seed("owner", rss.locator);
    for (let duplicate = 0; duplicate < 8; duplicate++) await seed();
    await seed("owner", "https://example.com/atom.xml");
    session.instrumentation.reset();
    await expect(
      findFeedForOrigins(session.database, "owner", [
        {
          kind: "rss",
          locator: rss.locator,
          alternateLocators: ["https://example.com/atom.xml"],
        },
        atmosphere,
      ]),
    ).rejects.toThrow(FEED_ORIGIN_CONFLICT);
    const evidence = session.instrumentation.snapshot();
    expect(evidence.statementCount).toBeLessThanOrEqual(2);
    expect(evidence.materializedRows).toBeLessThanOrEqual(2);
    expect(await session.database.select().from(feedOrigins)).toHaveLength(10);
  });
  it("keeps the lowest-id match for legacy duplicates of one exact locator", async () => {
    const first = await seed();
    await seed();
    expect(
      (await findFeedForOrigins(session.database, "owner", [rss]))?.id,
    ).toBe(first.id);
  });
  it("does not use stored alternates without fresh verification", async () => {
    await insertFeedWithOrigins(session.database, {
      userId: "owner",
      isActive: false,
      details: {
        ...newRssFeedDetails({
          url: "https://example.com/atom.xml",
          name: "My custom name",
          platform: "website",
        }),
        origins: [
          {
            kind: "rss",
            locator: "https://example.com/atom.xml",
            alternateLocators: [rss.locator],
          },
        ],
      },
    });
    expect(
      await findFeedForOrigins(session.database, "owner", [rss]),
    ).toBeUndefined();
  });
  it("does not reuse another user's Feed", async () => {
    await seed("other");
    expect(
      await findFeedForOrigins(session.database, "owner", [rss, atmosphere]),
    ).toBeUndefined();
  });
});

it("creates protocol details atomically and keeps them out of client contracts", async () => {
  const feed = await insertFeedWithOrigins(session.database, {
    userId: "owner",
    isActive: true,
    details: {
      name: "Both",
      platform: "website",
      origins: [
        {
          ...rss,
          etag: "rss-validator",
          alternateLocators: ["https://example.com/atom"],
        },
        atmosphere,
      ],
    },
  });
  const loaded = await loadOriginsForFeeds(session.database, [feed.id]);
  expect(loaded[0]?.rss).toMatchObject({
    etag: "rss-validator",
    alternateLocators: ["https://example.com/atom"],
  });
  expect(loaded[1]?.atproto).toMatchObject({
    publicationDid: "did:plc:example",
    listingEtag: null,
    initialized: false,
  });
  for (const origin of feedsSchema.parse(feed).origins) {
    expect(origin).not.toHaveProperty("rss");
    expect(origin).not.toHaveProperty("atproto");
    expect(origin).not.toHaveProperty("etag");
  }
  await expect(
    insertFeedWithOrigins(session.database, {
      userId: "owner",
      isActive: true,
      details: {
        name: "Invalid",
        platform: "website",
        origins: [rss, { kind: "atproto", locator: "invalid" }],
      },
    }),
  ).rejects.toThrow("Invalid publication URI");
  expect(await session.database.select().from(feeds)).toHaveLength(1);
  expect(await session.database.select().from(feedOrigins)).toHaveLength(2);
});

it("requires AT Protocol detail ownership for documents and cascades through it", async () => {
  const rssFeed = await seed();
  const feed = await attachMissingFeedOrigins(session.database, rssFeed, [
    atmosphere,
  ]);
  const atproto = feed.origins.find((origin) => origin.kind === "atproto")!;
  const record = {
    uri: "at://did:plc:example/site.standard.document/one",
    cid: "cid",
    status: "retry" as const,
  };
  await expect(
    session.database
      .insert(feedOriginAtprotoDocuments)
      .values({ ...record, originId: rssFeed.origins[0]!.id }),
  ).rejects.toThrow();
  await session.database
    .insert(feedOriginAtprotoDocuments)
    .values({ ...record, originId: atproto.id });
  await session.database
    .delete(feedOriginAtproto)
    .where(eq(feedOriginAtproto.originId, atproto.id));
  expect(
    await session.database.select().from(feedOriginAtprotoDocuments),
  ).toEqual([]);
  await expect(
    loadOriginsForFeeds(session.database, [feed.id]),
  ).rejects.toThrow("Missing atproto details");
  await session.database.delete(feeds).where(eq(feeds.id, feed.id));
  expect(await session.database.select().from(feedOrigins)).toEqual([]);
  expect(await session.database.select().from(feedOriginRss)).toEqual([]);
});
