import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import {
  atprotoConnections,
  feedOrigins,
  feeds,
  publicationBackfillProbes,
  user,
} from "~/server/db/schema";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  BACKFILL_BATCH_SIZE,
  BACKFILL_CONCURRENCY,
  backfillPublicationOrigins,
} from "~/server/publication-sync/backfill";
import { claimSubscriptionSync } from "~/server/publication-sync/state";
import { newRssFeedDetails } from "~/server/rss/types";

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;
const uri =
  "at://did:plc:abcdefghijklmnopqrstuvwx/site.standard.publication/blog";
const evidence = (urls = ["https://example.com/article"]) => ({
  origin: { kind: "atproto", locator: uri, sourceName: "Publication" },
  siteUrl: "https://example.com",
  itemUrls: new Set(urls),
});
const rssEvidence = async () => ({
  ...evidence(),
  origin: { kind: "rss", locator: "https://example.com/rss" },
});
const addFeed = (id: number) =>
  insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: newRssFeedDetails({
      name: `Feed ${id}`,
      platform: "website",
      url: `https://example.com/rss/${id}`,
      siteUrl: "https://example.com",
    }),
    isActive: false,
  });
beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  await fixture.database.insert(user).values({
    id: "owner",
    name: "Owner",
    email: "owner@example.com",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await fixture.database.insert(atprotoConnections).values({
    id: "connection",
    userId: "owner",
    did: "did:plc:abcdefghijklmnopqrstuvwx",
    session: "encrypted",
    scopes: "atproto include:site.standard.authSocial",
    exportSubscriptions: true,
  });
});
afterEach(() => fixture.cleanup());
const connection = async () =>
  (await fixture.database.select().from(atprotoConnections).get())!;
it("verifies overlapping articles, preserves an inactive custom Feed, and never repeats a completed probe", async () => {
  const feed = await addFeed(1);
  await fixture.database
    .update(feeds)
    .set({ name: "My name", nameEditedAt: new Date() })
    .where(eq(feeds.id, feed.id));
  const publication = vi.fn(async () => evidence());
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  expect(
    await backfillPublicationOrigins(fixture.database, claimed, {
      readOriginEvidence: rssEvidence,
      readBackfillPublication: publication,
    }),
  ).toMatchObject({ attached: 1 });
  expect(await fixture.database.select().from(feeds).get()).toMatchObject({
    id: feed.id,
    name: "My name",
    isActive: false,
  });
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
  await backfillPublicationOrigins(fixture.database, await connection(), {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: publication,
  });
  expect(publication).toHaveBeenCalledTimes(1);
});
it("records no overlap as complete without attaching the declaration", async () => {
  await addFeed(1);
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  const result = await backfillPublicationOrigins(fixture.database, claimed, {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: async () =>
      evidence(["https://example.com/other"]),
  });
  expect(result).toEqual({ attached: 0, retryAt: undefined });
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
  expect(
    await fixture.database.select().from(publicationBackfillProbes).get(),
  ).toMatchObject({ nextAttemptAt: null });
});
it("persists backoff across worker invocations and retries failed probes", async () => {
  await addFeed(1);
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  const publication = vi
    .fn()
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValue(evidence());
  const result = await backfillPublicationOrigins(fixture.database, claimed, {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: publication,
  });
  expect(result.retryAt!.getTime()).toBeGreaterThan(Date.now());
  await backfillPublicationOrigins(fixture.database, await connection(), {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: publication,
  });
  expect(publication).toHaveBeenCalledTimes(1);
  await fixture.database
    .update(publicationBackfillProbes)
    .set({ nextAttemptAt: new Date(0) });
  await fixture.database
    .update(atprotoConnections)
    .set({ subscriptionBackfillNextAttemptAt: new Date(0) });
  expect(
    await backfillPublicationOrigins(fixture.database, await connection(), {
      readOriginEvidence: rssEvidence,
      readBackfillPublication: publication,
    }),
  ).toMatchObject({ attached: 1 });
});
it("bounds each pass and leaves remaining Feeds durably pending", async () => {
  for (let i = 0; i < BACKFILL_BATCH_SIZE + 3; i++) await addFeed(i);
  let active = 0,
    maximum = 0;
  const publication = vi.fn(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return null;
  });
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  const result = await backfillPublicationOrigins(fixture.database, claimed, {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: publication,
  });
  expect(publication).toHaveBeenCalledTimes(BACKFILL_BATCH_SIZE);
  expect(maximum).toBeLessThanOrEqual(BACKFILL_CONCURRENCY);
  expect(result.retryAt).toBeInstanceOf(Date);
  await addFeed(100);
  await backfillPublicationOrigins(fixture.database, await connection(), {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: publication,
  });
  expect(publication).toHaveBeenCalledTimes(BACKFILL_BATCH_SIZE + 3);
});
it("does not attach a Publication already owned by another Feed", async () => {
  await addFeed(1);
  await insertFeedWithOrigins(fixture.database, {
    userId: "owner",
    details: {
      name: "Existing",
      platform: "website",
      origins: [evidence().origin],
    },
    isActive: true,
  });
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  expect(
    await backfillPublicationOrigins(fixture.database, claimed, {
      readOriginEvidence: rssEvidence,
      readBackfillPublication: async () => evidence(),
    }),
  ).toMatchObject({ attached: 0, retryAt: undefined });
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(2);
});
it("cannot attach after export is disabled during discovery", async () => {
  await addFeed(1);
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  const result = await backfillPublicationOrigins(fixture.database, claimed, {
    readOriginEvidence: rssEvidence,
    readBackfillPublication: async () => {
      await fixture.database
        .update(atprotoConnections)
        .set({ exportSubscriptions: false, syncSettingsVersion: 1 });
      return evidence();
    },
  });
  expect(result.attached).toBe(0);
  expect(await fixture.database.select().from(feedOrigins)).toHaveLength(1);
});

it("completes a declaration pointing to an unavailable Publication", async () => {
  const { PublicationUnavailableError } =
    await import("~/server/feeds/publications");
  await addFeed(1);
  const claimed = (await claimSubscriptionSync(fixture.database, "owner"))!;
  expect(
    await backfillPublicationOrigins(fixture.database, claimed, {
      readOriginEvidence: rssEvidence,
      readBackfillPublication: () =>
        Promise.reject(new PublicationUnavailableError("Deleted publication")),
    }),
  ).toMatchObject({ attached: 0, retryAt: undefined });
  expect(
    await fixture.database.select().from(publicationBackfillProbes).get(),
  ).toMatchObject({ nextAttemptAt: null });
});
