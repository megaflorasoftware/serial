import { and, eq, sql } from "drizzle-orm";
import type { db } from "~/server/db";
import type { AtprotoSyncPreferences } from "~/lib/auth/atproto-sync-settings";
import { newPublicationSyncRequest } from "~/server/publication-sync/requests";
import { syncSettingsFromPreferences } from "~/lib/auth/atproto-sync-settings";
import { atprotoConnections } from "~/server/db/schema";

export async function persistAtprotoSyncSettings(
  input: {
    userId: string;
    did: string;
    preferences: AtprotoSyncPreferences;
    expectedVersion?: number;
  },
  database: Pick<typeof db, "update">,
): Promise<boolean> {
  const preferences = syncSettingsFromPreferences(input.preferences);
  const result = await database
    .update(atprotoConnections)
    .set({
      ...preferences,
      ...newPublicationSyncRequest(
        preferences.importSubscriptions || preferences.exportSubscriptions,
      ),
      subscriptionImportGeneration: preferences.importSubscriptions
        ? sql`case when ${atprotoConnections.importSubscriptions} = 0 then ${atprotoConnections.subscriptionImportGeneration} + 1 else ${atprotoConnections.subscriptionImportGeneration} end`
        : atprotoConnections.subscriptionImportGeneration,
      subscriptionExportGeneration: preferences.exportSubscriptions
        ? sql`case when ${atprotoConnections.exportSubscriptions} = 0 then ${atprotoConnections.subscriptionExportGeneration} + 1 else ${atprotoConnections.subscriptionExportGeneration} end`
        : atprotoConnections.subscriptionExportGeneration,
      syncSettingsVersion: sql`${atprotoConnections.syncSettingsVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(atprotoConnections.userId, input.userId),
        eq(atprotoConnections.did, input.did),
        input.expectedVersion === undefined
          ? undefined
          : eq(atprotoConnections.syncSettingsVersion, input.expectedVersion),
      ),
    );
  return result.rowsAffected > 0;
}
