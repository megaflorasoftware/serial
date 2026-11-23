import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createBookmarkTestDatabase } from "../bookmarks/database";
import type { InStatement } from "@libsql/client";
import {
  feedOriginAtproto,
  feedOrigins,
  feeds,
  feedsSchema,
  user,
} from "~/server/db/schema";
import {
  insertFeedWithOrigins,
  loadUserFeedsWithOrigins,
} from "~/server/feeds/origins";
import { parseArrayOfSchema } from "~/lib/schemas/utils";

const FEED_URL = "https://blog.example.com/feed.xml";
const PUBLICATION = "at://did:plc:alice/site.standard.publication/site";

let fixture: Awaited<ReturnType<typeof createBookmarkTestDatabase>>;

beforeEach(async () => {
  fixture = await createBookmarkTestDatabase();
  const now = new Date();
  await fixture.database.insert(user).values(
    ["reader", "other"].map((id) => ({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
});

afterEach(() => fixture.cleanup());

function addFeed(
  userId: string,
  name: string,
  origins: Array<{ kind: "rss" | "atproto"; locator: string }>,
) {
  return insertFeedWithOrigins(fixture.database, {
    userId,
    isActive: true,
    details: { name, platform: "website", imageUrl: "", origins },
  });
}

it("returns each of the user's Feeds with its common origin rows only", async () => {
  const both = await addFeed("reader", "Both", [
    { kind: "rss", locator: FEED_URL },
    { kind: "atproto", locator: PUBLICATION },
  ]);
  const [bare] = await fixture.database
    .insert(feeds)
    .values({ userId: "reader", name: "Bare", platform: "website" })
    .returning();
  await addFeed("other", "Someone else's", [
    { kind: "rss", locator: FEED_URL },
  ]);
  // A Publication record is the largest value on the detail rows.
  await fixture.database.update(feedOriginAtproto).set({
    publicationRecord: {
      uri: PUBLICATION,
      cid: "bafy",
      value: { name: "Site", description: "x".repeat(2000) },
    },
  });
  const stored = await fixture.database
    .select()
    .from(feedOrigins)
    .where(eq(feedOrigins.feedId, both.id))
    .orderBy(feedOrigins.id);

  const execute = vi.spyOn(fixture.client, "execute");
  const loaded = await loadUserFeedsWithOrigins(fixture.database, "reader");

  expect(loaded.map((feed) => feed.name)).toEqual(["Both", "Bare"]);
  expect(loaded[0]?.origins).toEqual(stored);
  expect(loaded[0]?.origins.map((origin) => origin.kind)).toEqual([
    "rss",
    "atproto",
  ]);
  expect(loaded[1]).toMatchObject({ id: bare!.id, origins: [] });
  // The application shape is exactly what was read: nothing is dropped.
  expect(parseArrayOfSchema(loaded, feedsSchema)).toEqual(loaded);

  // One statement, and it never reads the protocol detail rows.
  expect(execute).toHaveBeenCalledTimes(1);
  const statement = execute.mock.calls[0]![0] as InStatement;
  const sql = typeof statement === "string" ? statement : statement.sql;
  expect(sql).not.toMatch(/serial_feed_origin_(rss|atproto)/);
});
