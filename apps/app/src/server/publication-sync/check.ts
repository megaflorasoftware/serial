import { sql } from "drizzle-orm";
import type { DatabaseAtprotoConnection } from "~/server/db/schema";
import { atprotoConnections as connections } from "~/server/db/schema";
import { hasAtprotoWriteScope } from "~/server/auth/atproto/config";

/** Whether backfill has work now, and when its next retry falls when it does not. */
export function backfillSchedule(
  connection: Pick<
    DatabaseAtprotoConnection,
    | "exportSubscriptions"
    | "scopes"
    | "subscriptionBackfillStarted"
    | "subscriptionBackfillNextAttemptAt"
  >,
  now: Date,
): { due: boolean; retryAt?: Date } {
  if (
    !connection.exportSubscriptions ||
    !hasAtprotoWriteScope(connection.scopes)
  )
    return { due: false };
  if (!connection.subscriptionBackfillStarted) return { due: true };
  const next = connection.subscriptionBackfillNextAttemptAt;
  if (!next) return { due: false };
  return next.getTime() > now.getTime()
    ? { due: false, retryAt: next }
    : { due: true };
}

/** Everything a check reads, so deciding costs one row and no claim. */
export const syncCheckColumns = {
  id: connections.id,
  userId: connections.userId,
  did: connections.did,
  status: connections.status,
  hasSession: sql<number>`${connections.session} is not null`.mapWith(Boolean),
  importSubscriptions: connections.importSubscriptions,
  exportSubscriptions: connections.exportSubscriptions,
  scopes: connections.scopes,
  subscriptionRepoRev: connections.subscriptionRepoRev,
  subscriptionRetryAt: connections.subscriptionRetryAt,
  subscriptionBackfillStarted: connections.subscriptionBackfillStarted,
  subscriptionBackfillNextAttemptAt:
    connections.subscriptionBackfillNextAttemptAt,
};
export type SyncCheckRow = Pick<
  DatabaseAtprotoConnection,
  | "id"
  | "userId"
  | "did"
  | "status"
  | "importSubscriptions"
  | "exportSubscriptions"
  | "scopes"
  | "subscriptionRepoRev"
  | "subscriptionRetryAt"
  | "subscriptionBackfillStarted"
  | "subscriptionBackfillNextAttemptAt"
> & { hasSession: boolean };

export type SyncCheck =
  | { state: "disabled" }
  /**
   * The repository and the local Feeds both match the last finished run.
   * `retryAt` is the earliest retry still waiting for its time.
   */
  | { state: "current"; retryAt?: Date }
  /** `rev` is present when the check already asked the PDS for it. */
  | { state: "due"; rev?: string | null };

export type LatestRev = (did: string) => Promise<string | null>;
const publicLatestRev: LatestRev = async (did) => {
  const { createPublicationClient } =
    await import("~/server/rss/atprotoClient");
  return createPublicationClient().latestRev(did);
};

function syncsSubscriptions(
  row: SyncCheckRow | undefined,
): row is SyncCheckRow {
  return (
    !!row?.userId &&
    row.hasSession &&
    row.status === "active" &&
    (row.importSubscriptions || row.exportSubscriptions)
  );
}

export function earliest(...times: Array<Date | null | undefined>) {
  const known = times.flatMap((time) => (time ? [time.getTime()] : []));
  return known.length ? new Date(Math.min(...known)) : null;
}

/**
 * Decide whether a run has work before anything is claimed. A stored revision
 * is the last one a run finished against with nothing left but retries waiting
 * for their time. Local changes, failures and settings saves clear it, so a
 * match with no retry due means nothing needs doing on either side.
 */
export async function checkPublicationSync(
  row: SyncCheckRow | undefined,
  latestRev: LatestRev = publicLatestRev,
  now = new Date(),
): Promise<SyncCheck> {
  if (!syncsSubscriptions(row)) return { state: "disabled" };
  const backfill = backfillSchedule(row, now);
  const importRetryDue =
    row.subscriptionRetryAt !== null &&
    row.subscriptionRetryAt.getTime() <= now.getTime();
  if (row.subscriptionRepoRev === null || backfill.due || importRetryDue)
    return { state: "due" };
  const rev = await latestRev(row.did);
  if (rev !== row.subscriptionRepoRev) return { state: "due", rev };
  const retryAt = earliest(backfill.retryAt, row.subscriptionRetryAt);
  return { state: "current", ...(retryAt ? { retryAt } : {}) };
}
