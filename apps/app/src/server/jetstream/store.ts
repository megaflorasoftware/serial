import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import {
  documentBelongsToPublication,
  parseDocumentRecord,
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
import { runDatabaseWrite } from "../db/retry-write";
import { getEffectivePlanConfig } from "../subscriptions/plans";
import { createStreamReporter } from "./report";
import { canApplyStream } from "./eligibility";
import { CheckpointHostError, normalizeService, sequence } from "./protocol";
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

export function originQuery(database: FeedDatabase) {
  return database
    .select({
      origin: feedOrigins,
      atproto: feedOriginAtproto,
      feed: feeds,
      account: user,
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
export async function claimStream(
  database: StreamDatabase,
  service: string,
  owner: string,
  now: Date,
) {
  await ensureStream(database, service);
  return runDatabaseWrite(database, async () => {
    const rows = await database
      .update(atprotoStreamState)
      .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + 60_000) })
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

/** Runs inside the caller's transaction. Supplied records are kept only while processing is pending. */
export async function stageDocument(
  database: FeedDatabase,
  input: {
    originId: number;
    uri: string;
    cid: string;
    record?: unknown;
    rev?: string | null;
    seq: number;
    deleted?: boolean;
  },
) {
  const old = await database
    .select()
    .from(feedOriginAtprotoDocuments)
    .where(
      and(
        eq(feedOriginAtprotoDocuments.originId, input.originId),
        eq(feedOriginAtprotoDocuments.uri, input.uri),
      ),
    )
    .get();
  if (
    old?.eventSeq !== null &&
    old?.eventSeq !== undefined &&
    sequence(old.eventSeq) >= input.seq
  )
    return;
  const document = input.deleted
    ? null
    : parseDocumentRecord({
        uri: input.uri,
        cid: input.cid,
        value: input.record,
      });
  const status = input.deleted
    ? "deleted"
    : document && Number.isFinite(Date.parse(document.value.publishedAt))
      ? "retry"
      : "invalid";
  const values = {
    originId: input.originId,
    uri: input.uri,
    cid: input.cid,
    status,
    eventSeq: String(input.seq),
    eventRev: input.rev ?? null,
    pendingRecord: status === "retry" ? input.record : null,
    attempts: 0,
    retryAt: null,
  } as const;
  await database
    .insert(feedOriginAtprotoDocuments)
    .values(values)
    .onConflictDoUpdate({
      target: [
        feedOriginAtprotoDocuments.originId,
        feedOriginAtprotoDocuments.uri,
      ],
      set: values,
    });
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
          if (row.atproto.streamMode !== "paused")
            await tx
              .update(feedOriginAtproto)
              .set({ streamMode: "paused" })
              .where(eq(feedOriginAtproto.originId, originId));
          return;
        }
        // Newly created origins first establish their bootstrap boundary.
        if (!row.atproto.streamSeq) return;
        if (!recovery && sequence(row.atproto.streamSeq) >= event.seq) return;
        const olderDocuments = and(
          eq(feedOriginAtprotoDocuments.originId, originId),
          or(
            isNull(feedOriginAtprotoDocuments.eventSeq),
            sql`cast(${feedOriginAtprotoDocuments.eventSeq} as integer) < ${event.seq}`,
          ),
        );
        if (event.kind === "commit") {
          if (row.atproto.accountStatus === "deleted" && row.atproto.accountSeq && event.seq <= sequence(row.atproto.accountSeq)) return;
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
                  publicationRecord:
                    event.commit.operation === "delete"
                      ? null
                      : {
                          uri,
                          cid: event.commit.cid,
                          value: event.commit.record,
                        },
                  publicationDirty: event.commit.operation !== "delete",
                })
                .where(eq(feedOriginAtproto.originId, originId));
              if (event.commit.operation === "delete")
                await tx
                  .update(feedOriginAtprotoDocuments)
                  .set({
                    status: "deleted",
                    pendingRecord: null,
                    eventSeq: String(event.seq),
                  })
                  .where(olderDocuments);
            }
          } else if (event.commit.collection === "site.standard.document") {
            if (row.atproto.publicationSeq && !row.atproto.publicationRecord && event.seq <= sequence(row.atproto.publicationSeq)) return;
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
              documentBelongsToPublication(
                parsed.value.site,
                row.origin.locator,
              );
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
              record: event.commit.record,
              rev: event.commit.rev,
              seq: event.seq,
              deleted: !belongs || event.commit.operation === "delete",
            });
          }
        } else if (event.kind === "identity") {
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
                pendingRecord: null,
                eventSeq: String(event.seq),
              })
              .where(
                and(
                  olderDocuments,
                  eq(feedOriginAtprotoDocuments.status, "retry"),
                ),
              );
          }
          if (event.kind === "sync") {
            await tx
              .update(feedOriginAtprotoDocuments)
              .set({
                status: "deleted",
                pendingRecord: null,
                eventSeq: String(event.seq),
              })
              .where(
                and(
                  olderDocuments,
                  or(
                    isNull(feedOriginAtprotoDocuments.eventRev),
                    lt(feedOriginAtprotoDocuments.eventRev, event.sync.rev),
                  ),
                  eq(feedOriginAtprotoDocuments.status, "retry"),
                ),
              );
          }
        }
        if (!recovery && row.atproto.streamMode === "live")
          await tx
            .update(feedOriginAtproto)
            .set({ streamSeq: String(event.seq) })
            .where(eq(feedOriginAtproto.originId, originId));
      },
      { behavior: "immediate" },
    ),
  );
}

export async function acceptBatch(
  database: StreamDatabase,
  batch: StreamBatch,
  settings: StreamSettings,
  options: {
    originId?: number;
    manual?: boolean;
    owner?: string;
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
  if (options.originId === undefined)
    await runDatabaseWrite(database, async () => {
      const result = await database
        .update(atprotoStreamState)
        .set({ seq: String(batch.lastCursor) })
        .where(
          and(
            eq(atprotoStreamState.id, "primary"),
            eq(atprotoStreamState.service, settings.service),
            options.owner
              ? eq(atprotoStreamState.leaseOwner, options.owner)
              : undefined,
            or(
              isNull(atprotoStreamState.seq),
              sql`cast(${atprotoStreamState.seq} as integer) <= ${batch.lastCursor}`,
            ),
          ),
        )
        .returning({ id: atprotoStreamState.id });
      if (!result.length)
        throw new Error("Jetstream checkpoint ownership changed");
    });
}
