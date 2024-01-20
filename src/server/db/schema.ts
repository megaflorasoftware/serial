// Example model schema from the Drizzle docs
// https://orm.drizzle.team/docs/sql-schema-declaration

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  text,
  sqliteTableCreator,
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
    userId: text("user_id").notNull(),
    name: text("name", { length: 256 }),
    url: text("url", { length: 512 }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (example) => ({
    nameIndex: index("name_idx").on(example.name),
  }),
);
