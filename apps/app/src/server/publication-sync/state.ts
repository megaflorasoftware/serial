import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { db as Database } from "~/server/db";
import type { FeedDatabase } from "~/server/feeds/origins";
import type { DatabaseAtprotoConnection } from "~/server/db/schema";
import { atprotoConnections } from "~/server/db/schema";
import { hasAtprotoWriteScope } from "~/server/auth/atproto/config";

const LEASE_MS = 180_000;
export class SubscriptionSyncChangedError extends Error {}
export async function claimSubscriptionSync(
  database: typeof Database,
  userId: string,
) {
  const token = randomUUID();
  const [connection] = await database
    .update(atprotoConnections)
    .set({
      subscriptionSyncToken: token,
      subscriptionSyncExpiresAt: new Date(Date.now() + LEASE_MS),
    })
    .where(
      and(
        eq(atprotoConnections.userId, userId),
        eq(atprotoConnections.status, "active"),
        or(
          eq(atprotoConnections.importSubscriptions, true),
          eq(atprotoConnections.exportSubscriptions, true),
        ),
        or(
          isNull(atprotoConnections.subscriptionSyncExpiresAt),
          lt(atprotoConnections.subscriptionSyncExpiresAt, new Date()),
        ),
      ),
    )
    .returning();
  return connection;
}
export function syncClaimCondition(connection: DatabaseAtprotoConnection) {
  return and(
    eq(atprotoConnections.id, connection.id),
    eq(atprotoConnections.userId, connection.userId!),
    eq(atprotoConnections.status, "active"),
    eq(atprotoConnections.syncSettingsVersion, connection.syncSettingsVersion),
    eq(
      atprotoConnections.subscriptionSyncToken,
      connection.subscriptionSyncToken!,
    ),
    gt(atprotoConnections.subscriptionSyncExpiresAt, new Date()),
  );
}
export async function assertSubscriptionSyncCurrent(
  database: FeedDatabase,
  connection: DatabaseAtprotoConnection,
  write = false,
) {
  const current = await database
    .select({
      scopes: atprotoConnections.scopes,
      session: atprotoConnections.session,
    })
    .from(atprotoConnections)
    .where(syncClaimCondition(connection))
    .get();
  if (!current?.session)
    throw new SubscriptionSyncChangedError(
      "Atmosphere connection or sync settings changed. Try syncing again.",
    );
  if (write && !hasAtprotoWriteScope(current.scopes))
    throw new Error(
      "Atmosphere permissions changed. Save your sync settings to grant permission again.",
    );
}
export async function renewSubscriptionSync(
  database: typeof Database,
  connection: DatabaseAtprotoConnection,
) {
  const result = await database
    .update(atprotoConnections)
    .set({ subscriptionSyncExpiresAt: new Date(Date.now() + LEASE_MS) })
    .where(syncClaimCondition(connection));
  if (!result.rowsAffected)
    throw new SubscriptionSyncChangedError(
      "Atmosphere sync settings changed. Try syncing again.",
    );
}
