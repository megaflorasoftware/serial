import { and, eq, isNull, lte, or } from "drizzle-orm";
import { user } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import type { db } from "../db";

const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** App loads and explicit refreshes coalesce nearby activity writes. */
export function recordUserActivity(
  database: typeof db,
  userId: string,
  now = new Date(),
) {
  return runDatabaseWrite(database, () =>
    database
      .update(user)
      .set({ lastActiveAt: now })
      .where(
        and(
          eq(user.id, userId),
          or(
            isNull(user.lastActiveAt),
            lte(
              user.lastActiveAt,
              new Date(now.getTime() - ACTIVITY_WRITE_INTERVAL_MS),
            ),
          ),
        ),
      ),
  );
}
