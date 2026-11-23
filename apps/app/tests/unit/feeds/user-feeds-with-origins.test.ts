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

function statementSql(statement: InStatement) {
  return typeof statement === "string" ? statement : statement.sql;
}

/** The plan SQLite chooses for a statement the application issued. */
async function queryPlan(sql: string) {
  const plan = await fixture.client.execute({
    sql: `EXPLAIN QUERY PLAN ${sql}`,
    args: Array.from(sql.matchAll(/\?/g), () => 0),
  });
  return plan.rows.map((row) => String(row.detail));
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
  const statements = execute.mock.calls.map(([statement]) =>
    statementSql(statement as InStatement),
  );
  execute.mockRestore();

  expect(loaded.map((feed) => feed.name)).toEqual(["Both", "Bare"]);
  expect(loaded[0]?.origins).toEqual(stored);
  expect(loaded[0]?.origins.map((origin) => origin.kind)).toEqual([
    "rss",
    "atproto",
  ]);
  expect(loaded[1]).toMatchObject({ id: bare!.id, origins: [] });
  // The application shape is exactly what was read: nothing is dropped.
  expect(parseArrayOfSchema(loaded, feedsSchema)).toEqual(loaded);

  // Feeds by user and origins by user, and neither reads the protocol detail rows.
  expect(statements).toHaveLength(2);
  for (const sql of statements)
    expect(sql).not.toMatch(/serial_feed_origin_(rss|atproto)|join/i);
  // Each statement walks its index by user once. A sort or a seek per Feed
  // would read every row again.
  expect(await Promise.all(statements.map(queryPlan))).toEqual(
    expect.arrayContaining([
      ["SEARCH serial_feed USING INDEX feed_user_id_idx (user_id=?)"],
      [
        "SEARCH serial_feed_origin USING INDEX feed_origin_user_id_kind_locator_idx (user_id=?)",
      ],
    ]),
  );
});

it("keeps Feeds and their origins in id order whatever order the indexes hold them in", async () => {
  // The origin index by user keeps kind and locator order, which is the
  // reverse of the order these origins were created in.
  const first = await addFeed("reader", "First", [
    { kind: "rss", locator: "https://zebra.example.com/feed.xml" },
    { kind: "atproto", locator: PUBLICATION },
  ]);
  await addFeed("other", "Someone else's", [
    { kind: "rss", locator: FEED_URL },
  ]);
  const second = await addFeed("reader", "Second", [
    { kind: "rss", locator: "https://apple.example.com/feed.xml" },
  ]);

  const loaded = await loadUserFeedsWithOrigins(fixture.database, "reader");

  expect(loaded.map((feed) => feed.id)).toEqual([first.id, second.id]);
  expect(loaded.map((feed) => feed.origins.map((origin) => origin.id))).toEqual(
    [
      first.origins.map((origin) => origin.id),
      second.origins.map((origin) => origin.id),
    ],
  );
  expect(first.origins[0]!.id).toBeLessThan(first.origins[1]!.id);
  expect(
    loaded.flatMap((feed) => feed.origins.map((origin) => origin.feedId)),
  ).toEqual([first.id, first.id, second.id]);
});
