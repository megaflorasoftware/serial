import { and, eq, inArray } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { ResultSet } from "@libsql/client";
import type { SQLiteTransaction } from "drizzle-orm/sqlite-core";

import type { ApplicationFeed } from "~/server/db/schema";
import * as schema from "~/server/db/schema";
import { fetchNewFeedDetails } from "~/server/rss/fetchFeeds";
import { parseArrayOfSchema } from "~/lib/schemas/utils";
import { getFeedRssUrl } from "~/lib/feeds/origins";
import {
  findFeedByRssUrl,
  insertFeedWithOrigins,
} from "~/server/feeds/origins";

type SerialSchema = typeof schema;

type Transaction = SQLiteTransaction<
  "async",
  ResultSet,
  SerialSchema,
  ExtractTablesWithRelations<SerialSchema>
>;

export async function verifyFeedsOwnedByUser({
  feedIds,
  userId,
  db,
}: {
  feedIds: number[];
  userId: string;
  db: Transaction;
}): Promise<boolean> {
  if (feedIds.length === 0) {
    return true;
  }

  const userFeeds = await db
    .select({ id: schema.feeds.id })
    .from(schema.feeds)
    .where(
      and(inArray(schema.feeds.id, feedIds), eq(schema.feeds.userId, userId)),
    );

  return userFeeds.length === feedIds.length;
}

export async function verifyViewsOwnedByUser({
  viewIds,
  userId,
  db,
}: {
  viewIds: number[];
  userId: string;
  db: Transaction;
}): Promise<boolean> {
  if (viewIds.length === 0) {
    return true;
  }

  const userViews = await db
    .select({ id: schema.views.id })
    .from(schema.views)
    .where(
      and(inArray(schema.views.id, viewIds), eq(schema.views.userId, userId)),
    );

  return userViews.length === viewIds.length;
}

export async function verifyContentCategoriesOwnedByUser({
  categoryIds,
  userId,
  db,
}: {
  categoryIds: number[];
  userId: string;
  db: Transaction;
}): Promise<boolean> {
  if (categoryIds.length === 0) {
    return true;
  }

  const userCategories = await db
    .select({ id: schema.contentCategories.id })
    .from(schema.contentCategories)
    .where(
      and(
        inArray(schema.contentCategories.id, categoryIds),
        eq(schema.contentCategories.userId, userId),
      ),
    );

  return userCategories.length === categoryIds.length;
}

/** Bulk statements stay well under SQLite's bind-variable limit. */
export const BULK_INSERT_BATCH_SIZE = 200;

function chunkRows<T>(rows: T[], size: number = BULK_INSERT_BATCH_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

/**
 * Run one statement per chunk of `rows` and collect the results in order.
 * The chunks exist only to stay under the bind-variable limit, not to fan
 * work out: the statements run inside a transaction that shares a single
 * connection, so they are issued sequentially by design.
 */
export async function runInChunks<T, TResult>(
  rows: T[],
  statement: (chunk: T[]) => Promise<TResult>,
) {
  const results: TResult[] = [];
  for (const chunk of chunkRows(rows)) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const result = await statement(chunk);
    results.push(result);
  }
  return results;
}

/**
 * Create any missing tags by name and link the given feeds to them.
 * Idempotent: existing tags are reused and existing links are kept.
 */
export async function applyFeedCategories(
  db: Transaction,
  userId: string,
  entries: Array<{ feedId: number; categories: string[] }>,
) {
  const names = [
    ...new Set(entries.flatMap((entry) => entry.categories)),
  ].filter((name) => !!name);
  if (names.length === 0) return;

  const categoryByName = new Map<string, { id: number }>();
  const matchingCategories = await runInChunks(names, (nameChunk) =>
    db
      .select()
      .from(schema.contentCategories)
      .where(
        and(
          inArray(schema.contentCategories.name, nameChunk),
          eq(schema.contentCategories.userId, userId),
        ),
      )
      .all(),
  );
  for (const category of matchingCategories.flat()) {
    categoryByName.set(category.name, { id: category.id });
  }

  const namesToCreate = names.filter((name) => !categoryByName.has(name));
  const createdCategories = await runInChunks(namesToCreate, (nameChunk) =>
    db
      .insert(schema.contentCategories)
      .values(nameChunk.map((name) => ({ name, userId })))
      .returning({
        id: schema.contentCategories.id,
        name: schema.contentCategories.name,
      }),
  );
  for (const category of createdCategories.flat()) {
    categoryByName.set(category.name, { id: category.id });
  }

  const feedCategoryRows = entries.flatMap((entry) =>
    entry.categories.flatMap((name) => {
      const category = categoryByName.get(name);
      return category
        ? [{ feedId: entry.feedId, categoryId: category.id }]
        : [];
    }),
  );
  await runInChunks(feedCategoryRows, (rowChunk) =>
    db.insert(schema.feedCategories).values(rowChunk).onConflictDoNothing(),
  );
}

export type InsertFeedWithCategoriesSuccess = {
  success: true;
  feedId: number;
  feed: ApplicationFeed;
};

export type InsertFeedWithCategoriesError = {
  success: false;
  error: string;
  /** Set when the failure is a duplicate, so callers can still link the feed. */
  existingFeed?: ApplicationFeed;
};

export type InsertFeedWithCategoriesResult =
  InsertFeedWithCategoriesSuccess | InsertFeedWithCategoriesError;

/**
 * Insert a feed with its categories, handling both existing and new categories.
 * This is the core logic extracted from createFromSubscriptionImport.
 */
export async function insertFeedWithCategories(
  db: Transaction,
  userId: string,
  feedInput: { feedUrl: string; categories: string[] },
  isActive: boolean = true,
): Promise<InsertFeedWithCategoriesResult> {
  const newFeedDetails = await fetchNewFeedDetails(feedInput.feedUrl);
  const newFeed = newFeedDetails[0];
  const newFeedUrl = newFeed ? getFeedRssUrl(newFeed) : "";

  if (!newFeed || !newFeedUrl) {
    return {
      success: false,
      error: "Unsupported feed URL",
    };
  }

  const existingFeed = await findFeedByRssUrl(db, {
    feedUrl: newFeedUrl,
    userId,
  });

  if (existingFeed) {
    const [existingApplicationFeed] = parseArrayOfSchema(
      [existingFeed],
      schema.feedsSchema,
    );
    if (!existingApplicationFeed) {
      return {
        success: false,
        error: "Couldn't read the existing feed",
      };
    }
    return {
      success: false,
      error: "Feed already exists",
      existingFeed: existingApplicationFeed,
    };
  }

  const newFeedRow = await insertFeedWithOrigins(db, {
    userId,
    details: newFeed,
    isActive,
  });

  await applyFeedCategories(db, userId, [
    { feedId: newFeedRow.id, categories: feedInput.categories },
  ]);

  // Parse the feed to ApplicationFeed format
  const [applicationFeed] = parseArrayOfSchema(
    [newFeedRow],
    schema.feedsSchema,
  );

  return {
    success: true,
    feedId: newFeedRow.id,
    feed: applicationFeed!,
  };
}
