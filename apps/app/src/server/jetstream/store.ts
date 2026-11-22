import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  documentBelongsToPublication,
  parseDocumentRecord,
  stringifyLosslessJson,
} from "@serial/standard-site";
import {
  atprotoStreamState,
  feedOriginAtproto,
  feedOriginAtprotoDocuments,
  feedOrigins,
  feeds,
  user,
} from "../db/schema";
import { hydrateOrigin } from "../feeds/origins";
import { makeOriginsDue } from "../feeds/schedule";
import { runDatabaseWrite } from "../db/retry-write";
import { getEffectivePlanConfig } from "../subscriptions/plans";
import {
  captureRecordValue,
  isRecordOverBudget,
  pruneDocumentSources,
  stageDocumentSources,
} from "./document-source";
import { createStreamReporter } from "./report";
import { canApplyStream } from "./eligibility";
import { CheckpointHostError, normalizeService, sequence } from "./protocol";
import type { CapturedRecord } from "./document-source";
import type { getUserPlanId } from "../subscriptions/helpers";
import type { PlanConfig } from "../subscriptions/plans";
import type { StreamBatch, StreamEvent } from "./protocol";
import type { FeedDatabase } from "../feeds/origins";
import type { db } from "../db";

export const ORIGIN_PAGE_SIZE = 50;
export type StreamDatabase = typeof db;
export type StreamSettings = {
  service: string;
  backgroundEnabled: boolean;
  getPlanId?: typeof getUserPlanId;
  now?: () => Date;
};
export const nowFor = (settings: StreamSettings) =>
  settings.now?.() ?? new Date();

/** What stream work reads from the owning account: eligibility and plan. */
const streamAccount = {
  id: user.id,
  role: user.role,
  banned: user.banned,
  banExpires: user.banExpires,
  lastActiveAt: user.lastActiveAt,
};
/** What stream work reads from the Feed: activity, item writes and metadata. */
const streamFeed = {
  id: feeds.id,
  name: feeds.name,
  platform: feeds.platform,
  siteUrl: feeds.siteUrl,
  isActive: feeds.isActive,
};
export function originQuery(database: FeedDatabase) {
  return database
    .select({
      origin: feedOrigins,
      atproto: feedOriginAtproto,
      feed: streamFeed,
      account: streamAccount,
    })
    .from(feedOriginAtproto)
    .innerJoin(feedOrigins, eq(feedOrigins.id, feedOriginAtproto.originId))
    .innerJoin(feeds, eq(feeds.id, feedOrigins.feedId))
    .innerJoin(user, eq(user.id, feedOrigins.userId));
}
export async function loadOrigin(database: FeedDatabase, originId: number) {
  const row = await originQuery(database)
    .where(eq(feedOriginAtproto.originId, originId))
    .get();
  return row
    ? { ...row, origin: hydrateOrigin({ ...row, rss: null }) }
    : undefined;
}
export type StreamOrigin = NonNullable<Awaited<ReturnType<typeof loadOrigin>>>;
export async function planFor(
  row: Pick<StreamOrigin, "account">,
  settings: StreamSettings,
): Promise<PlanConfig> {
  const getPlan =
    settings.getPlanId ??
    (await import("../subscriptions/helpers")).getUserPlanId;
  return getEffectivePlanConfig(await getPlan(row.account.id), {
    isAdmin: row.account.role === "admin",
  });
}
export function eligible(
  row: StreamOrigin,
  plan: PlanConfig,
  settings: StreamSettings,
  manual = false,
) {
  return canApplyStream({
    account: row.account,
    activeFeed: row.feed.isActive,
    plan,
    backgroundEnabled: settings.backgroundEnabled,
    now: nowFor(settings),
    manual,
  });
}
export async function ensureStream(database: StreamDatabase, service: string) {
  const normalized = normalizeService(service);
  await runDatabaseWrite(database, () =>
    database
      .insert(atprotoStreamState)
      .values({ id: "primary", service: normalized })
      .onConflictDoNothing(),
  );
  const state = (await database
    .select()
    .from(atprotoStreamState)
    .where(eq(atprotoStreamState.id, "primary"))
    .get())!;
  if (state.service !== normalized) throw new CheckpointHostError();
  return state;
}
/** The stored checkpoint moved forward to `checkpoint`; it never moves back. */
function advancedCheckpoint(checkpoint: number) {
  return sql`case when ${atprotoStreamState.seq} is null or cast(${atprotoStreamState.seq} as integer) <= ${checkpoint} then ${String(checkpoint)} else ${atprotoStreamState.seq} end`;
}

/**
 * Takes or renews the lease. The worker's checkpoint rides along, so saving
 * progress costs no statement of its own.
 */
export async function holdStream(
  database: StreamDatabase,
  owner: string,
  now: Date,
  checkpoint?: number,
) {
  return runDatabaseWrite(database, async () => {
    const rows = await database
      .update(atprotoStreamState)
      .set({
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + 60_000),
        ...(checkpoint === undefined
          ? {}
          : { seq: advancedCheckpoint(checkpoint) }),
      })
      .where(
        and(
          eq(atprotoStreamState.id, "primary"),
          or(
            isNull(atprotoStreamState.leaseUntil),
            lt(atprotoStreamState.leaseUntil, now),
            eq(atprotoStreamState.leaseOwner, owner),
          ),
        ),
      )
      .returning({ id: atprotoStreamState.id });
    return rows.length > 0;
  });
}
export async function claimStream(
  database: StreamDatabase,
  service: string,
  owner: string,
  now: Date,
) {
  await ensureStream(database, service);
  return holdStream(database, owner, now);
}

const currentStreamGeneration = sql`(select ${atprotoStreamState.generation} from ${atprotoStreamState} where ${atprotoStreamState.id} = 'primary')`;

/** Origins in live mode: the only ones a covered schedule trusted the stream for. */
const originInLiveMode = and(
  eq(feedOrigins.kind, "atproto"),
  sql`exists (select 1 from ${feedOriginAtproto} where ${and(
    eq(feedOriginAtproto.originId, feedOrigins.id),
    eq(feedOriginAtproto.streamMode, "live"),
  )})`,
);

/**
 * The stream stopped vouching for the origins it applied live, so each
 * recovers at its next refresh instead of waiting out a covered schedule.
 * Polled origins and origins in a recovery backoff keep their own schedule.
 */
export function makeStreamOriginsDue(
  database: Pick<FeedDatabase, "update">,
  now: Date,
) {
  return makeOriginsDue(database, originInLiveMode, now);
}

function streamOwnedBy(owner: string) {
  return and(
    eq(atprotoStreamState.id, "primary"),
    eq(atprotoStreamState.leaseOwner, owner),
  );
}

/** Saves the owner's progress without extending its lease, as a connection ends. */
export async function saveCheckpoint(
  database: StreamDatabase,
  owner: string,
  checkpoint: number,
) {
  await runDatabaseWrite(database, () =>
    database
      .update(atprotoStreamState)
      .set({ seq: advancedCheckpoint(checkpoint) })
      .where(streamOwnedBy(owner)),
  );
}

/** Marks the owner's connection live; false when it lost the lease or its generation. */
export async function connectStream(
  database: StreamDatabase,
  owner: string,
  generation: number,
  now: Date,
) {
  const rows = await runDatabaseWrite(database, () =>
    database
      .update(atprotoStreamState)
      .set({ connected: true })
      .where(
        and(
          streamOwnedBy(owner),
          eq(atprotoStreamState.generation, generation),
          gt(atprotoStreamState.leaseUntil, now),
        ),
      )
      .returning({ id: atprotoStreamState.id }),
  );
  return rows.length > 0;
}

/**
 * The connection ended. Nothing else changes: the next connection resumes
 * from the checkpoint and replays what this one missed, so origins keep their
 * generation and their schedule.
 */
export async function disconnectStream(
  database: StreamDatabase,
  owner: string,
) {
  await runDatabaseWrite(database, () =>
    database
      .update(atprotoStreamState)
      .set({ connected: false })
      .where(and(streamOwnedBy(owner), eq(atprotoStreamState.connected, true))),
  );
}

/**
 * Events were lost for good: the service rejected the resume cursor, or could
 * not vouch for it. The new generation sends every origin through recovery,
 * and the origins the stream covered become due so that happens at their next
 * refresh. The checkpoint clears, so the next connection resumes at the tip.
 */
export async function declareStreamGap(
  database: StreamDatabase,
  owner: string,
  now: Date,
) {
  return runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
        const marked = await tx
          .update(atprotoStreamState)
          .set({
            generation: sql`${atprotoStreamState.generation} + 1`,
            connected: false,
            seq: null,
          })
          .where(streamOwnedBy(owner))
          .returning({ generation: atprotoStreamState.generation });
        if (marked.length) await makeStreamOriginsDue(tx, now);
        return marked;
      },
      { behavior: "immediate" },
    ),
  );
}

/** A generation no stream ever has, so the origin recovers at its next refresh. */
const DISTRUSTED_GENERATION = -1;
const DISTRUST_PAGE_SIZE = 200;

/**
 * The stream followed these origins too late to vouch for what they missed.
 * Outside the current generation an origin keeps its pre-gap cursor, and
 * making it due sends it through catch-up from there.
 */
export async function distrustOriginCoverage(
  database: StreamDatabase,
  originIds: number[],
  now: Date,
) {
  for (
    let offset = 0;
    offset < originIds.length;
    offset += DISTRUST_PAGE_SIZE
  ) {
    const page = originIds.slice(offset, offset + DISTRUST_PAGE_SIZE);
    // Bound each statement below SQLite's host-parameter limit.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await runDatabaseWrite(database, () =>
      database.transaction(
        async (tx) => {
          await tx
            .update(feedOriginAtproto)
            .set({ streamGeneration: DISTRUSTED_GENERATION })
            .where(inArray(feedOriginAtproto.originId, page));
          await makeOriginsDue(tx, inArray(feedOrigins.id, page), now);
        },
        { behavior: "immediate" },
      ),
    );
  }
}

export function streamIsConnected(
  state: typeof atprotoStreamState.$inferSelect,
  now: Date,
) {
  return state.connected && state.leaseUntil !== null && state.leaseUntil > now;
}

type StreamState = typeof atprotoStreamState.$inferSelect;

/** A connected worker applies this origin's events as they arrive. */
export function originAppliesLive(
  row: Pick<StreamOrigin, "atproto">,
  state: StreamState,
  now: Date,
) {
  return (
    row.atproto.initialized &&
    row.atproto.streamMode === "live" &&
    row.atproto.streamGeneration === state.generation &&
    streamIsConnected(state, now)
  );
}

/**
 * Holds in SQL while the origin still applies live events at the stream's
 * current generation; a pause or a new generation since makes it false.
 */
export function originStillAppliesLive(originId: number) {
  return sql`exists (select 1 from ${feedOriginAtproto} where ${feedOriginAtproto.originId} = ${originId} and ${feedOriginAtproto.streamMode} = 'live' and ${feedOriginAtproto.streamGeneration} = ${currentStreamGeneration})`;
}

export type StagedDocumentInput = {
  originId: number;
  uri: string;
  cid: string;
  record?: CapturedRecord;
  rev?: string | null;
  seq: number;
  deleted?: boolean;
  now?: Date;
};

function stagedValues(
  input: StagedDocumentInput,
  old: typeof feedOriginAtprotoDocuments.$inferSelect | undefined,
) {
  const document = input.deleted
    ? null
    : parseDocumentRecord({
        uri: input.uri,
        cid: input.cid,
        value: input.record?.value,
      });
  const oversized = document !== null && isRecordOverBudget(input.record!.text);
  const status = input.deleted
    ? "deleted"
    : document &&
        !oversized &&
        Number.isFinite(Date.parse(document.value.publishedAt))
      ? "retry"
      : "invalid";
  return {
    originId: input.originId,
    uri: input.uri,
    cid: input.cid,
    status,
    eventSeq: String(input.seq),
    eventRev: input.rev ?? null,
    bodyCid: old?.bodyCid ?? null,
    reason: status === "invalid" ? (oversized ? "oversized" : "invalid") : null,
    attempts: 0,
    retryAt: null,
  } as const;
}

/**
 * Runs inside the caller's transaction. Staged records live in their own
 * source rows; the ledger only records that work is pending. One page of
 * documents costs a fixed handful of statements.
 */
export async function stageDocuments(
  database: FeedDatabase,
  inputs: StagedDocumentInput[],
) {
  if (!inputs.length) return;
  const originId = inputs[0]!.originId;
  const existing = await database
    .select()
    .from(feedOriginAtprotoDocuments)
    .where(
      and(
        eq(feedOriginAtprotoDocuments.originId, originId),
        inArray(
          feedOriginAtprotoDocuments.uri,
          inputs.map((input) => input.uri),
        ),
      ),
    );
  const old = new Map(existing.map((row) => [row.uri, row]));
  const staged = inputs
    .filter((input) => {
      const seq = old.get(input.uri)?.eventSeq;
      return seq === null || seq === undefined || sequence(seq) < input.seq;
    })
    .map((input) => ({
      input,
      values: stagedValues(input, old.get(input.uri)),
    }));
  if (!staged.length) return;
  for (let offset = 0; offset < staged.length; offset += 50) {
    // Bound each statement below SQLite's host-parameter limit.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    await database
      .insert(feedOriginAtprotoDocuments)
      .values(staged.slice(offset, offset + 50).map((entry) => entry.values))
      .onConflictDoUpdate({
        target: [
          feedOriginAtprotoDocuments.originId,
          feedOriginAtprotoDocuments.uri,
        ],
        set: {
          cid: sql`excluded.cid`,
          status: sql`excluded.status`,
          eventSeq: sql`excluded.event_seq`,
          eventRev: sql`excluded.event_rev`,
          bodyCid: sql`excluded.body_cid`,
          reason: sql`excluded.reason`,
          attempts: sql`excluded.attempts`,
          retryAt: sql`excluded.retry_at`,
        },
      });
  }
  const retrying = staged.filter((entry) => entry.values.status === "retry");
  await stageDocumentSources(
    database,
    retrying.map(({ input }) => ({
      originId,
      uri: input.uri,
      cid: input.cid,
      record: input.record!.text,
      createdAt: input.now ?? new Date(),
    })),
  );
  // The readable version survives; a newer staged version replaces older staging.
  await pruneDocumentSources(
    database,
    originId,
    staged.map(({ input, values }) => ({
      uri: input.uri,
      keep: [values.bodyCid, values.status === "retry" ? input.cid : null],
    })),
  );
}

export async function stageDocument(
  database: FeedDatabase,
  input: StagedDocumentInput,
) {
  await stageDocuments(database, [input]);
}

/** Rounds a lossless value through ordinary JSON, for columns that store it that way. */
function plainJson(value: unknown): unknown {
  return JSON.parse(stringifyLosslessJson(value));
}

function olderDocuments(originId: number, seq: number) {
  return and(
    eq(feedOriginAtprotoDocuments.originId, originId),
    or(
      isNull(feedOriginAtprotoDocuments.eventSeq),
      sql`cast(${feedOriginAtprotoDocuments.eventSeq} as integer) < ${seq}`,
    ),
  );
}
async function applyCommit(
  tx: FeedDatabase,
  row: StreamOrigin,
  event: Extract<StreamEvent, { kind: "commit" }>,
) {
  const originId = row.origin.id;
  if (
    row.atproto.accountStatus === "deleted" &&
    row.atproto.accountSeq &&
    event.seq <= sequence(row.atproto.accountSeq)
  )
    return;
  const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
  if (event.commit.collection === "site.standard.publication") {
    if (uri !== row.origin.locator) return;
    if (
      !row.atproto.publicationSeq ||
      sequence(row.atproto.publicationSeq) < event.seq
    ) {
      await tx
        .update(feedOriginAtproto)
        .set({
          publicationSeq: String(event.seq),
          // The publication column is ordinary JSON; only documents keep 64-bit digits.
          publicationRecord:
            event.commit.operation === "delete"
              ? null
              : {
                  uri,
                  cid: event.commit.cid,
                  value: plainJson(event.commit.record),
                },
          publicationDirty: event.commit.operation !== "delete",
        })
        .where(eq(feedOriginAtproto.originId, originId));
      if (event.commit.operation === "delete")
        await tx
          .update(feedOriginAtprotoDocuments)
          .set({
            status: "deleted",
            eventSeq: String(event.seq),
          })
          .where(olderDocuments(originId, event.seq));
    }
  } else if (event.commit.collection === "site.standard.document") {
    if (
      row.atproto.publicationSeq &&
      !row.atproto.publicationRecord &&
      event.seq <= sequence(row.atproto.publicationSeq)
    )
      return;
    if (
      row.atproto.repositoryRev &&
      event.commit.rev < row.atproto.repositoryRev
    )
      return;
    const parsed = parseDocumentRecord({
      uri,
      cid: event.commit.cid,
      value: event.commit.record,
    });
    const belongs =
      !parsed ||
      documentBelongsToPublication(parsed.value.site, row.origin.locator);
    if (!belongs || event.commit.operation === "delete") {
      const known = await tx
        .select({ uri: feedOriginAtprotoDocuments.uri })
        .from(feedOriginAtprotoDocuments)
        .where(
          and(
            eq(feedOriginAtprotoDocuments.originId, originId),
            eq(feedOriginAtprotoDocuments.uri, uri),
          ),
        )
        .get();
      if (!known) return;
    }
    await stageDocument(tx, {
      originId,
      uri,
      cid: event.commit.cid ?? "",
      record:
        event.commit.record === undefined
          ? undefined
          : event.commit.recordText !== undefined
            ? { text: event.commit.recordText, value: event.commit.record }
            : captureRecordValue(event.commit.record),
      rev: event.commit.rev,
      seq: event.seq,
      deleted: !belongs || event.commit.operation === "delete",
    });
  }
}
async function applyMarker(
  tx: FeedDatabase,
  row: StreamOrigin,
  event: Exclude<StreamEvent, { kind: "commit" }>,
) {
  const originId = row.origin.id;
  if (event.kind === "identity") {
    if (
      !row.atproto.identitySeq ||
      sequence(row.atproto.identitySeq) < event.seq
    )
      await tx
        .update(feedOriginAtproto)
        .set({ identitySeq: String(event.seq) })
        .where(eq(feedOriginAtproto.originId, originId));
    // Public PDS lookups resolve the DID without cache for each processing operation.
  } else if (
    !(event.kind === "account"
      ? row.atproto.accountSeq
      : row.atproto.repositorySeq) ||
    sequence(
      (event.kind === "account"
        ? row.atproto.accountSeq
        : row.atproto.repositorySeq)!,
    ) < event.seq
  ) {
    await tx
      .update(feedOriginAtproto)
      .set({
        ...(event.kind === "account"
          ? {
              accountSeq: String(event.seq),
              repositoryActive: event.account.active,
              accountStatus: event.account.status ?? null,
            }
          : {
              repositorySeq: String(event.seq),
              repositoryRev: event.sync.rev,
            }),
      })
      .where(eq(feedOriginAtproto.originId, originId));
    if (
      event.kind === "account" &&
      !event.account.active &&
      event.account.status === "deleted"
    ) {
      await tx
        .update(feedOriginAtprotoDocuments)
        .set({
          status: "deleted",
          eventSeq: String(event.seq),
        })
        .where(
          and(
            olderDocuments(originId, event.seq),
            eq(feedOriginAtprotoDocuments.status, "retry"),
          ),
        );
    }
    if (event.kind === "sync") {
      await tx
        .update(feedOriginAtprotoDocuments)
        .set({
          status: "deleted",
          eventSeq: String(event.seq),
        })
        .where(
          and(
            olderDocuments(originId, event.seq),
            or(
              isNull(feedOriginAtprotoDocuments.eventRev),
              lt(feedOriginAtprotoDocuments.eventRev, event.sync.rev),
            ),
            eq(feedOriginAtprotoDocuments.status, "retry"),
          ),
        );
    }
  }
}

/**
 * The stream stops applying an origin whose Feed or account no longer
 * qualifies for it. The origin becomes due, so its next refresh catches up;
 * an inactive Feed's origin is unscheduled and stays that way.
 */
export async function pauseOriginStream(
  tx: FeedDatabase,
  row: Pick<StreamOrigin, "origin" | "atproto">,
  now: Date,
) {
  if (
    row.atproto.streamMode === "paused" ||
    row.atproto.streamMode === "direct"
  )
    return;
  await tx
    .update(feedOriginAtproto)
    .set({ streamMode: "paused" })
    .where(eq(feedOriginAtproto.originId, row.origin.id));
  await makeOriginsDue(tx, eq(feedOrigins.id, row.origin.id), now);
}

async function acceptOriginEvent(
  database: StreamDatabase,
  originId: number,
  event: StreamEvent,
  plan: PlanConfig,
  settings: StreamSettings,
  recovery: boolean,
  manual: boolean,
) {
  return runDatabaseWrite(database, () =>
    database.transaction(
      async (tx) => {
        const row = await loadOrigin(tx, originId);
        if (!row) return;
        if (
          row.atproto.streamService &&
          row.atproto.streamService !== settings.service
        )
          throw new CheckpointHostError();
        if (!eligible(row, plan, settings, manual)) {
          await pauseOriginStream(tx, row, nowFor(settings));
          return;
        }
        // Newly created origins first establish their bootstrap boundary.
        if (!row.atproto.streamSeq) return;
        if (!recovery && sequence(row.atproto.streamSeq) >= event.seq) return;
        if (event.kind === "commit") await applyCommit(tx, row, event);
        else await applyMarker(tx, row, event);
        if (!recovery && row.atproto.streamMode === "live")
          await tx
            .update(feedOriginAtproto)
            .set({ streamSeq: String(event.seq) })
            .where(
              and(
                eq(feedOriginAtproto.originId, originId),
                // Keep the pre-gap cursor even while newer live events are applied.
                sql`${feedOriginAtproto.streamGeneration} = ${currentStreamGeneration}`,
              ),
            );
      },
      { behavior: "immediate" },
    ),
  );
}

/**
 * Applies events to the origins that follow their publisher. Saving stream
 * progress is the worker's job, on its lease heartbeat.
 */
export async function acceptBatch(
  database: StreamDatabase,
  batch: Pick<StreamBatch, "events">,
  settings: StreamSettings,
  options: {
    originId?: number;
    manual?: boolean;
    onOrigins?: (originIds: number[]) => Promise<void>;
  } = {},
) {
  for (const event of batch.events) {
    if (
      event.kind === "commit" &&
      event.commit.operation !== "delete" &&
      event.commit.collection === "site.standard.document" &&
      !parseDocumentRecord({
        uri: `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`,
        cid: event.commit.cid,
        value: event.commit.record,
      })
    )
      createStreamReporter(settings.service)(
        new Error("Invalid document record"),
        "document-validation",
      );
    let after = 0;
    while (true) {
      const rows = await originQuery(database)
        .where(
          and(
            eq(feedOriginAtproto.publicationDid, event.did),
            gt(feedOriginAtproto.originId, after),
            options.originId
              ? eq(feedOriginAtproto.originId, options.originId)
              : undefined,
          ),
        )
        .orderBy(asc(feedOriginAtproto.originId))
        .limit(ORIGIN_PAGE_SIZE);
      if (!rows.length) break;
      const plans = new Map<string, Promise<PlanConfig>>();
      for (const row of rows) {
        let plan = plans.get(row.account.id);
        if (!plan) {
          plan = planFor(row, settings);
          plans.set(row.account.id, plan);
        }
        await acceptOriginEvent(
          database,
          row.origin.id,
          event,
          await plan,
          settings,
          options.originId !== undefined,
          Boolean(options.manual),
        );
      }
      await options.onOrigins?.(rows.map((row) => row.origin.id));
      after = rows.at(-1)!.origin.id;
    }
  }
}
