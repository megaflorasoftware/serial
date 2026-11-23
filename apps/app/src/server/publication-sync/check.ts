import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SubscriptionListing } from "./record-store";
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
  subscriptionListingDigest: connections.subscriptionListingDigest,
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
  | "subscriptionListingDigest"
  | "subscriptionRetryAt"
  | "subscriptionBackfillStarted"
  | "subscriptionBackfillNextAttemptAt"
> & { hasSession: boolean };

export type SyncCheck =
  | { state: "disabled" }
  /**
   * The subscriptions and the local Feeds both match the last finished run.
   * `retryAt` is the earliest retry still waiting for its time. `rev` is a
   * newer revision at which the listing is still the one that run saw, for
   * the caller to store.
   */
  | { state: "current"; retryAt?: Date; rev?: string }
  /**
   * `rev` is present when the check already asked the PDS for it, and
   * `listing` when it also read the subscriptions after that.
   */
  | { state: "due"; rev?: string | null; listing?: SubscriptionListing };

/** What a check asks the PDS: the repository's revision, and its subscriptions once that moved. */
export type SubscriptionRemote = {
  latestRev: (did: string) => Promise<string | null>;
  list: (did: string) => Promise<SubscriptionListing>;
};
const publicRemote: SubscriptionRemote = {
  async latestRev(did) {
    const { createPublicationClient } =
      await import("~/server/rss/atprotoClient");
    return createPublicationClient().latestRev(did);
  },
  async list(did) {
    const { createPublicSubscriptionStore } = await import("./record-store");
    // The collection is public and read without a session. A check never writes.
    return createPublicSubscriptionStore({
      did,
      authorizeWrite: () =>
        Promise.reject(new Error("A sync check does not write")),
    }).list();
  },
};

/**
 * One comparable text for a listing: every record by URI and CID, and every
 * record that does not parse by URI. A run has work on the remote side only
 * when one of these differs from the listing the last run saw. The CID covers
 * the publication a record names.
 */
export function listingDigest(listing: SubscriptionListing) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        listing.records.map((record) => [record.uri, record.cid]).sort(),
        [...listing.invalidRecordUris].sort(),
      ]),
    )
    .digest("base64url");
}

/** The listing as the PDS gives it now, or nothing when it cannot be read. */
async function readListing(remote: SubscriptionRemote, did: string) {
  try {
    return await remote.list(did);
  } catch {
    // The run lists for itself and owns what a failed listing means.
    return undefined;
  }
}

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
 *
 * The revision moves with every post and like, so a moved one is not work by
 * itself. The check then reads the subscriptions, and only a listing that
 * differs from the one that run saw is work. The revision is read before the
 * listing: a change made while the listing is read moves the revision past
 * the one the caller stores, and the next check reads again.
 */
export async function checkPublicationSync(
  row: SyncCheckRow | undefined,
  remote: SubscriptionRemote = publicRemote,
  now = new Date(),
): Promise<SyncCheck> {
  if (!syncsSubscriptions(row)) return { state: "disabled" };
  const backfill = backfillSchedule(row, now);
  const retryDue =
    row.subscriptionRetryAt !== null &&
    row.subscriptionRetryAt.getTime() <= now.getTime();
  if (row.subscriptionRepoRev === null || backfill.due || retryDue)
    return { state: "due" };
  const rev = await remote.latestRev(row.did);
  const retryAt = earliest(backfill.retryAt, row.subscriptionRetryAt);
  const current = {
    state: "current" as const,
    ...(retryAt ? { retryAt } : {}),
  };
  if (rev === row.subscriptionRepoRev) return current;
  if (rev === null) return { state: "due", rev };
  // The listing is read after the revision the caller stores it against.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const listing = await readListing(remote, row.did);
  if (!listing) return { state: "due", rev };
  return listingDigest(listing) === row.subscriptionListingDigest
    ? { ...current, rev }
    : { state: "due", rev, listing };
}
