import { and, eq, exists, sql } from "drizzle-orm";
import type { AtprotoSyncPreferences } from "~/lib/auth/atproto-sync-settings";
import type { FeedDatabase } from "~/server/feeds/origins";
import {
  FULL_RECONCILE,
  newPublicationSyncRequest,
  RETRY_REFUSED_WRITES,
} from "~/server/publication-sync/requests";
import { syncSettingsFromPreferences } from "~/lib/auth/atproto-sync-settings";
import { atprotoConnections } from "~/server/db/schema";
import { queuePublicationBackfill } from "~/server/origin-checks/queue";

export async function persistAtprotoSyncSettings(
  input: {
    userId: string;
    did: string;
    preferences: AtprotoSyncPreferences;
    expectedVersion?: number;
  },
  database: FeedDatabase,
): Promise<boolean> {
  const preferences = syncSettingsFromPreferences(input.preferences);
  const connection = and(
    eq(atprotoConnections.userId, input.userId),
    eq(atprotoConnections.did, input.did),
    input.expectedVersion === undefined
      ? undefined
      : eq(atprotoConnections.syncSettingsVersion, input.expectedVersion),
  );
  // Export enabled for the first time since the link queues Publication
  // backfill for the Feeds that existed before it. The two writes need no
  // transaction only because a repeated queue insert is ignored: a save that
  // loses its version race may still have queued light checks, which is
  // harmless.
  if (preferences.exportSubscriptions)
    await queuePublicationBackfill(
      database,
      input.userId,
      exists(
        database
          .select({ id: atprotoConnections.id })
          .from(atprotoConnections)
          .where(
            and(
              connection,
              eq(atprotoConnections.subscriptionBackfillStarted, false),
            ),
          ),
      ),
    );
  const result = await database
    .update(atprotoConnections)
    .set({
      ...preferences,
      ...newPublicationSyncRequest(
        preferences.importSubscriptions || preferences.exportSubscriptions,
      ),
      ...FULL_RECONCILE,
      ...RETRY_REFUSED_WRITES,
      ...(preferences.exportSubscriptions
        ? { subscriptionBackfillStarted: true }
        : {}),
      subscriptionImportGeneration: preferences.importSubscriptions
        ? sql`case when ${atprotoConnections.importSubscriptions} = 0 then ${atprotoConnections.subscriptionImportGeneration} + 1 else ${atprotoConnections.subscriptionImportGeneration} end`
        : atprotoConnections.subscriptionImportGeneration,
      subscriptionExportGeneration: preferences.exportSubscriptions
        ? sql`case when ${atprotoConnections.exportSubscriptions} = 0 then ${atprotoConnections.subscriptionExportGeneration} + 1 else ${atprotoConnections.subscriptionExportGeneration} end`
        : atprotoConnections.subscriptionExportGeneration,
      syncSettingsVersion: sql`${atprotoConnections.syncSettingsVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(connection);
  return result.rowsAffected > 0;
}
