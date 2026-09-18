import { eq, sql } from "drizzle-orm";
import { appActivityOperations, user } from "../db/schema";
import { runDatabaseWrite } from "../db/retry-write";
import type { db } from "../db";

/** Only authenticated app loads and explicit refreshes call this; never ingestion. */
export function recordUserActivity(
  database: typeof db,
  userId: string,
  now = new Date(),
  operationId?: string,
) {
  return runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
        if (operationId) {
          // A load has three bounded requests; receipts outlive that retry window by a day.
          await tx
            .delete(appActivityOperations)
            .where(
              sql`rowid in (select rowid from ${appActivityOperations} where ${appActivityOperations.createdAt} < ${now.getTime() - 86_400_000} limit 100)`,
            );
          const inserted = await tx
            .insert(appActivityOperations)
            .values({ userId, operationId, createdAt: now })
            .onConflictDoNothing()
            .returning({ id: appActivityOperations.operationId });
          if (!inserted.length) return;
        }
        await tx
          .update(user)
          .set({ lastActiveAt: now })
          .where(eq(user.id, userId));
      },
      { behavior: "immediate" },
    ),
  );
}
