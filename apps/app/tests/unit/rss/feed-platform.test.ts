import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { stringifyLosslessJson } from "@serial/standard-site";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { HydratedFeedOrigin } from "~/server/db/schema";
import { insertFeedWithOrigins } from "~/server/feeds/origins";
import {
  feedOriginAtprotoDocuments,
  feedOriginAtprotoDocumentSources,
  feeds,
  user,
} from "~/server/db/schema";
import {
  applyOriginMetadata,
  atmospherePlatformOf,
  recomputeFeedPlatform,
} from "~/server/rss/originMetadata";

vi.mock("~/lib/semaphore", () => ({
  dbSemaphore: { run: <T>(fn: () => T) => fn() },
}));

const DID = "did:plc:alice";
const PUB = `at://${DID}/site.standard.publication/site`;
const uri = (rkey: string) => `at://${DID}/site.standard.document/${rkey}`;

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

/** One readable document version whose source carries the given content `$type`. */
async function retain(
  rkey: string,
  contentType: string | null,
  options: { status?: "ready" | "retry"; readable?: boolean } = {},
) {
  const cid = `cid-${rkey}`;
  await fixture.database.insert(feedOriginAtprotoDocuments).values({
    originId: origin.id,
    uri: uri(rkey),
    cid,
    status: options.status ?? "ready",
    bodyCid: options.readable === false ? null : cid,
  });
  await fixture.database.insert(feedOriginAtprotoDocumentSources).values({
    originId: origin.id,
    uri: uri(rkey),
    cid,
    record: stringifyLosslessJson({
      title: rkey,
      site: PUB,
      publishedAt: "2026-09-15T12:00:00Z",
      ...(contentType ? { content: { $type: contentType } } : {}),
    }),
    createdAt: new Date(),
  });
}

async function storedPlatform() {
  const row = await fixture.database
    .select({ platform: feeds.platform })
    .from(feeds)
    .where(eq(feeds.id, feed.id))
    .get();
  return row!.platform;
}

it("stays website at creation and with no retained sources", async () => {
  expect(await storedPlatform()).toBe("website");
  expect(await atmospherePlatformOf(fixture.database, origin.id)).toBe(
    "website",
  );
  expect(
    await recomputeFeedPlatform(fixture.database, feed, origin.id),
  ).toBe(false);
});

it.each([
  ["pub.leaflet.content", "leaflet"],
  ["blog.pckt.content", "pckt"],
  ["app.offprint.content", "offprint"],
] as const)(
  "takes the platform every retained %s source agrees on",
  async (contentType, platform) => {
    await retain("001", contentType);
    await retain("002", contentType);
    expect(
      await recomputeFeedPlatform(fixture.database, feed, origin.id),
    ).toBe(true);
    expect(await storedPlatform()).toBe(platform);
    // Unchanged on a second pass.
    expect(
      await recomputeFeedPlatform(
        fixture.database,
        { ...feed, platform },
        origin.id,
      ),
    ).toBe(false);
  },
);

it("falls back to website when the sources disagree or one is unregistered", async () => {
  await retain("001", "pub.leaflet.content");
  await retain("002", "blog.pckt.content");
  expect(await atmospherePlatformOf(fixture.database, origin.id)).toBe(
    "website",
  );
  await fixture.database
    .delete(feedOriginAtprotoDocuments)
    .where(eq(feedOriginAtprotoDocuments.uri, uri("002")));
  await retain("003", "at.markpub.markdown");
  expect(await atmospherePlatformOf(fixture.database, origin.id)).toBe(
    "website",
  );
});

it("reads only the readable version of ready documents", async () => {
  await retain("001", "pub.leaflet.content");
  await retain("002", "blog.pckt.content", { status: "retry" });
  await retain("003", "app.offprint.content", { readable: false });
  expect(await atmospherePlatformOf(fixture.database, origin.id)).toBe(
    "leaflet",
  );
});

it("returns to website when a specific platform no longer agrees", async () => {
  await retain("001", "pub.leaflet.content");
  await fixture.database
    .update(feeds)
    .set({ platform: "leaflet" })
    .where(eq(feeds.id, feed.id));
  await retain("002", "blog.pckt.content");
  expect(
    await recomputeFeedPlatform(
      fixture.database,
      { ...feed, platform: "leaflet" },
      origin.id,
    ),
  ).toBe(true);
  expect(await storedPlatform()).toBe("website");
});

it("leaves an RSS video platform alone", async () => {
  await fixture.database
    .update(feeds)
    .set({ platform: "youtube" })
    .where(eq(feeds.id, feed.id));
  await retain("001", "pub.leaflet.content");
  expect(
    await recomputeFeedPlatform(
      fixture.database,
      { ...feed, platform: "youtube" },
      origin.id,
    ),
  ).toBe(false);
  expect(await storedPlatform()).toBe("youtube");
});

it("recomputes inside the origin metadata refresh and reports the change", async () => {
  await retain("001", "app.offprint.content");
  const metadata = {
    name: "Publication",
    imageUrl: null,
    description: null,
    siteUrl: "https://example.com",
  };
  expect(
    await applyOriginMetadata(fixture.database, { origin, feed }, metadata),
  ).toBe(true);
  expect(await storedPlatform()).toBe("offprint");
  const current = (await fixture.database
    .select()
    .from(feeds)
    .where(eq(feeds.id, feed.id))
    .get())!;
  const refreshed = { ...origin, sourceName: "Publication" };
  expect(
    await applyOriginMetadata(
      fixture.database,
      { origin: refreshed, feed: current },
      { ...metadata, siteUrl: current.siteUrl },
    ),
  ).toBe(false);
});
