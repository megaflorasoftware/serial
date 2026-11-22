import { asc, gt } from "drizzle-orm";
import { feedOriginAtproto } from "../db/schema";
import type { StreamEvent } from "./protocol";
import type { StreamDatabase } from "./store";

const PUBLICATION_PAGE_SIZE = 1000;
/** How long a skipped event stays replayable; several lease heartbeats wide. */
export const SKIPPED_EVENT_WINDOW_MS = 2 * 60 * 1000;
export const SKIPPED_EVENT_BUDGET_BYTES = 8 * 1024 * 1024;

type FollowedPublication = { originId: number; did: string };

/** Origins created after `originId`, oldest first. An origin's publisher never changes. */
async function publicationsAfter(
  database: StreamDatabase,
  originId: number,
): Promise<FollowedPublication[]> {
  return database
    .select({
      originId: feedOriginAtproto.originId,
      did: feedOriginAtproto.publicationDid,
    })
    .from(feedOriginAtproto)
    .where(gt(feedOriginAtproto.originId, originId))
    .orderBy(asc(feedOriginAtproto.originId))
    .limit(PUBLICATION_PAGE_SIZE);
}

/** Every origin created after `originId`, read a bounded page at a time. */
export async function loadPublicationsAfter(
  database: StreamDatabase,
  originId: number,
) {
  const publications: FollowedPublication[] = [];
  let after = originId;
  while (true) {
    // Each page starts after the previous page's last origin.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const page = await publicationsAfter(database, after);
    publications.push(...page);
    if (page.length < PUBLICATION_PAGE_SIZE) return publications;
    after = page.at(-1)!.originId;
  }
}

type SkippedEvent = { event: StreamEvent; at: number; bytes: number };

/**
 * Events skipped because nobody followed their publisher when they arrived.
 * An origin created on another instance reaches the followed set a heartbeat
 * later; the events in between are replayed from here. The buffer answers for
 * an interval only while nothing arriving inside it has been evicted.
 */
export function createSkippedEvents(
  startedAt: number,
  limits = {
    windowMs: SKIPPED_EVENT_WINDOW_MS,
    budgetBytes: SKIPPED_EVENT_BUDGET_BYTES,
  },
) {
  let entries: SkippedEvent[] = [];
  let bytes = 0;
  // Every skipped event that arrived at or after this time is still held.
  let completeFrom = startedAt;
  function evictOldest() {
    const oldest = entries.shift()!;
    bytes -= oldest.bytes;
    completeFrom = Math.max(completeFrom, oldest.at + 1);
  }
  function expire(now: number) {
    while (entries[0] && entries[0].at < now - limits.windowMs) evictOldest();
    completeFrom = Math.max(completeFrom, now - limits.windowMs);
  }
  return {
    add(event: StreamEvent, now: number) {
      expire(now);
      const size = Buffer.byteLength(JSON.stringify(event));
      entries.push({ event, at: now, bytes: size });
      bytes += size;
      while (bytes > limits.budgetBytes) evictOldest();
    },
    /** Whether every event skipped since `since` is still held. */
    covers(since: number, now: number) {
      expire(now);
      return since >= completeFrom;
    },
    /** Removes and returns the held events of these publishers, in arrival order. */
    take(dids: ReadonlySet<string>) {
      const taken = entries.filter((entry) => dids.has(entry.event.did));
      entries = entries.filter((entry) => !dids.has(entry.event.did));
      bytes -= taken.reduce((total, entry) => total + entry.bytes, 0);
      return taken.map((entry) => entry.event);
    },
  };
}

/** Runs one piece of work at a time, in the order it was asked for. */
function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

export type StreamIntake = Awaited<ReturnType<typeof startStreamIntake>>;

/**
 * Decides which stream events reach the database. Events for publishers
 * nobody follows are skipped in memory, so network-wide traffic costs no
 * statements. Batches and refreshes run one at a time, which keeps a replayed
 * event ahead of the live events that follow it. The followed set is built
 * once per connection: a deleted origin's publisher stays in it until the
 * next connection, which only costs a lookup that finds nothing.
 */
export async function startStreamIntake(input: {
  database: StreamDatabase;
  /** Applies events for followed publishers, oldest first. */
  apply: (events: StreamEvent[]) => Promise<void>;
  /** Origins that joined when the skipped events could not be vouched for. */
  distrust: (originIds: number[]) => Promise<void>;
  now?: () => number;
  limits?: Parameters<typeof createSkippedEvents>[1];
}) {
  const now = input.now ?? Date.now;
  const serial = createSerialQueue();
  const startedAt = now();
  const skipped = createSkippedEvents(startedAt, input.limits);
  const followed = new Set<string>();
  let newestOriginId = 0;
  let refreshedAt = startedAt;
  let applied: number | undefined;
  let checkpoint: number | undefined;
  let replayLost = false;

  /** Follows publishers of new origins, handing them the events skipped meanwhile. */
  async function followNewPublications() {
    const since = refreshedAt;
    const startedRefreshAt = now();
    const joined = await loadPublicationsAfter(input.database, newestOriginId);
    refreshedAt = startedRefreshAt;
    if (!joined.length) return;
    newestOriginId = joined.at(-1)!.originId;
    const unfollowed = joined.filter(({ did }) => !followed.has(did));
    const dids = new Set(unfollowed.map(({ did }) => did));
    const vouched = skipped.covers(since, now());
    // Taking the events and following the publishers happen in one step, so
    // no event for them can be skipped in between.
    const missed = skipped.take(dids);
    for (const did of dids) followed.add(did);
    if (!vouched)
      await input.distrust(unfollowed.map(({ originId }) => originId));
    else if (missed.length) await input.apply(missed);
  }

  const existing = await loadPublicationsAfter(input.database, 0);
  for (const { did } of existing) followed.add(did);
  newestOriginId = existing.at(-1)?.originId ?? 0;
  return {
    /** Applies a batch's followed events and skips the rest. */
    accept(batch: { events: StreamEvent[]; lastCursor: number }) {
      return serial(async () => {
        const events = batch.events.filter((event) => {
          if (followed.has(event.did)) return true;
          skipped.add(event, now());
          return false;
        });
        if (events.length) await input.apply(events);
        applied = batch.lastCursor;
      });
    },
    /**
     * Picks up origins created since the last refresh, then marks the progress
     * made before it as safe to resume from: every origin older than that
     * point is followed, so a restart there loses nothing.
     */
    refresh() {
      return serial(async () => {
        // A failed replay lost its events here; only a restart from the
        // checkpoint saved before them brings them back.
        if (replayLost) throw new Error("Stream intake lost a replay");
        const reached = applied;
        try {
          await followNewPublications();
        } catch (error) {
          replayLost = true;
          throw error;
        }
        checkpoint = reached;
      });
    },
    /** The newest stream position a restart may resume from. */
    checkpoint: () => checkpoint,
  };
}
