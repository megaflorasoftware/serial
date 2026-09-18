import { eq } from "drizzle-orm";
import { user } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import type { db } from "../db";

/** Only authenticated app loads and explicit refreshes call this; never ingestion. */
export function recordUserActivity(
  database: typeof db,
  userId: string,
  now = new Date(),
) {
  return runDatabaseWrite(database, () =>
    database.update(user).set({ lastActiveAt: now }).where(eq(user.id, userId)),
  );
}
