// Example model schema from the Drizzle docs
// https://orm.drizzle.team/docs/sql-schema-declaration

import { sql } from "drizzle-orm";
import {
  integer,
  text,
  sqliteTableCreator,
  index,
  primaryKey,
} from "drizzle-orm/sqlite-core";

/**
 * This is an example of how to use the multi-project schema feature of Drizzle ORM. Use the same
 * database instance for multiple projects.
 *
 * @see https://orm.drizzle.team/docs/goodies#multi-project-schema
 */
export const sqliteTable = sqliteTableCreator((name) => `serial_${name}`);

export const feeds = sqliteTable(
  "feed",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull().default(""),
    name: text("name", { length: 256 }).notNull().default(""),
    url: text("url", { length: 512 }).notNull().default(""),
    platform: text("platform", { length: 256 }).notNull().default("youtube"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (example) => ({
    nameIndex: index("feed_name_idx").on(example.name),
  }),
);

export const feedItems = sqliteTable(
  "feed_item",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    feedId: integer("feed_id").references(() => feeds.id),
    contentId: text("content_id", { length: 512 }).notNull(),
    title: text("title", { length: 512 }).notNull(),
    url: text("url", { length: 512 }).notNull(),
    isWatched: integer("is_watched", { mode: "boolean" })
      .notNull()
      .default(false),
    isHidden: integer("is_hidden", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (example) => ({
    feedIdIndex: index("feed_item_feed_id_idx").on(example.feedId),
  }),
);

export const contentCategories = sqliteTable(
  "content_categories",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull().default(""),
    name: text("name", { length: 256 }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (example) => ({
    nameIndex: index("content_categories_name_idx").on(example.name),
  }),
);

export const feedCategories = sqliteTable(
  "feed_categories",
  {
    feedId: integer("feed_id").references(() => feeds.id),
    categoryId: integer("category_id").references(() => contentCategories.id),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.feedId, table.categoryId] }),
  }),
);
