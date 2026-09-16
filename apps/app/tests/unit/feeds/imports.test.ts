import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { NewFeedOriginDetails } from "~/server/rss/types";
import { commitFeedImport, prepareFeedImport } from "~/server/feeds/imports";
import { insertFeedWithCategories } from "~/server/api/routers/feed-router/utils";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  FeedImportDeferredError,
  FeedImportSkippedError,
} from "~/server/feeds/importErrors";
import { feedCategories, feedOrigins, feeds, user } from "~/server/db/schema";
import { newRssFeedDetails } from "~/server/rss/types";

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const site = "https://example.com";
const rss = newRssFeedDetails({
  name: "RSS",
  platform: "website",
  siteUrl: site,
  url: `${site}/rss`,
});
const atproto = {
  kind: "atproto",
  locator: "at://did:plc:example/site.standard.publication/one",
};
const publication = {
  name: "Publication",
  platform: "website" as const,
  siteUrl: site,
  origins: [atproto],
};
const readOriginEvidence = vi.fn(async (origin: NewFeedOriginDetails) => ({
  origin,
  siteUrl: site,
  itemUrls: new Set([`${site}/article`]),
}));
const prepare = (details = rss) =>
  prepareFeedImport(fixture.database, "owner", details, { readOriginEvidence });
const commit = (prepared: Awaited<ReturnType<typeof prepare>>) =>
  fixture.database.transaction(
    (tx) => commitFeedImport(tx, "owner", prepared, true),
    { behavior: "immediate" },
  );
beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values(
    ["owner", "other"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  );
  readOriginEvidence.mockReset().mockImplementation(async (origin) => ({
    origin,
    siteUrl: site,
    itemUrls: new Set([`${site}/article`]),
  }));
});
afterEach(() => fixture.cleanup());

it("attaches OPML RSS to a verified inactive publication without changing its settings or organization", async () => {
  const original = await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: { ...publication, name: "Custom", nameEditedAt: new Date() },
    isActive: false,
  });
  const prepared = await prepare();
  const result = await fixture.database.transaction((tx) =>
    insertFeedWithCategories(
      tx,
      "owner",
      { feedUrl: `${site}/rss`, categories: ["Unwanted tag"] },
      prepared,
      0,
    ),
  );
  expect(result).toMatchObject({
    success: true,
    reused: true,
    feedId: original.id,
  });
  expect(await fixture.database.select().from(feeds)).toEqual([
    Object.fromEntries(
      Object.entries(original).filter(([key]) => key !== "origins"),
    ),
  ]);
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
  expect(await fixture.database.select().from(feedCategories)).toHaveLength(0);
  expect(readOriginEvidence).toHaveBeenCalledTimes(2);
  readOriginEvidence.mockClear();
  expect(await commit(await prepare())).toMatchObject({
    created: false,
    attached: false,
    feed: { id: original.id },
  });
  expect(readOriginEvidence).not.toHaveBeenCalled();
});

it("attaches Atmosphere to matching RSS and preserves its identity", async () => {
  const original = await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: rss,
    isActive: true,
  });
  const result = await commit(await prepare(publication));
  expect(result).toMatchObject({
    created: false,
    attached: true,
    feed: { id: original.id, name: "RSS" },
  });
  expect(await fixture.database.select().from(feeds)).toHaveLength(1);
});

it("skips a same-site candidate without overlapping articles", async () => {
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: publication,
    isActive: true,
  });
  readOriginEvidence.mockImplementation(async (origin) => ({
    origin,
    siteUrl: site,
    itemUrls: new Set([`${site}/${origin.kind}`]),
  }));
  await expect(prepare()).rejects.toBeInstanceOf(FeedImportSkippedError);
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
});

it("does not use another user's matching publication", async () => {
  await insertFeedWithOrigins(fixture.database, {
    userId: "other",
    details: publication,
    isActive: true,
  });
  expect(await commit(await prepare())).toMatchObject({
    created: true,
    feed: { userId: "owner" },
  });
  expect(readOriginEvidence).not.toHaveBeenCalled();
});

it("defers a failed article check without creating a second Feed", async () => {
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: publication,
    isActive: true,
  });
  readOriginEvidence.mockRejectedValue(new Error("PDS offline"));
  await expect(prepare()).rejects.toThrow("PDS offline");
  expect(await fixture.database.select().from(feeds)).toHaveLength(1);
});

it("rechecks a new same-site Feed inserted after verification", async () => {
  const prepared = await prepare();
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: publication,
    isActive: true,
  });
  await expect(commit(prepared)).rejects.toBeInstanceOf(
    FeedImportDeferredError,
  );
  expect(await fixture.database.select().from(feeds)).toHaveLength(1);
});

it("preserves a concurrent rename but rejects a changed origin", async () => {
  const original = await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: publication,
    isActive: true,
  });
  const prepared = await prepare();
  await fixture.database
    .update(feeds)
    .set({ name: "Renamed", isActive: false })
    .where(eq(feeds.id, original.id));
  expect(await commit(prepared)).toMatchObject({
    feed: { name: "Renamed", isActive: false },
  });
  await fixture.database
    .update(feedOrigins)
    .set({ locator: `${atproto.locator}-other` })
    .where(eq(feedOrigins.kind, "atproto"));
  await expect(commit(prepared)).rejects.toBeInstanceOf(FeedImportSkippedError);
});

it("does not merge two existing Feeds when later discovery finds both origins", async () => {
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: publication,
    isActive: true,
  });
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: rss,
    isActive: true,
  });
  await expect(
    prepare({ ...publication, origins: [...rss.origins, atproto] }),
  ).rejects.toBeInstanceOf(FeedImportSkippedError);
  expect(await fixture.database.select().from(feeds)).toHaveLength(2);
});

it("enforces the active limit at commit without charging a reused Feed against the next entry", async () => {
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: publication,
    isActive: false,
  });
  const reused = await prepare();
  await fixture.database.transaction((tx) =>
    insertFeedWithCategories(
      tx,
      "owner",
      { feedUrl: `${site}/rss`, categories: [] },
      reused,
      1,
    ),
  );
  const next = newRssFeedDetails({
    name: "New",
    platform: "website",
    siteUrl: "https://other.com",
    url: "https://other.com/rss",
  });
  const prepared = await prepare(next);
  const result = await fixture.database.transaction((tx) =>
    insertFeedWithCategories(
      tx,
      "owner",
      { feedUrl: "https://other.com/rss", categories: [] },
      prepared,
      1,
    ),
  );
  expect(result).toMatchObject({
    success: true,
    reused: false,
    feed: { isActive: true },
  });
});
