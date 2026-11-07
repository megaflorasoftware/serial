import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { bookmarkScopeCondition, feedScopeCondition } from "./scope";
import type { SQL } from "drizzle-orm";
import type {
  MixedContentCursor,
  MixedContentEntityKind,
  MixedContentScope,
} from "../projection";
import type { ScopeData } from "./scope";
import type { db as defaultDatabase } from "~/server/db";
import type { ApplicationFeedItem } from "~/server/db/schema";
import type { ContentStatusFilter } from "~/lib/content-status";
import { selectContentStatusOrderValue } from "~/lib/content-status";
import { bookmarks, feedItems, feeds } from "~/server/db/schema";
import { UNCATEGORIZED_SECTION_PLACEMENT } from "~/lib/views/sections";
import {
  compareDescendingIds,
  compareDescendingIdsThenKinds,
} from "~/lib/sortOrder";

type MixedContentDatabase = typeof defaultDatabase;

export type FeedCandidate = {
  entityKind: "feed-item";
  entityId: string;
  item: ApplicationFeedItem;
  sectionPlacement: number | null;
  normalizedAt: Date;
};

export type BookmarkCandidate = {
  entityKind: "bookmark";
  entityId: string;
  sectionPlacement: number | null;
  normalizedAt: Date;
};

export type Candidate = FeedCandidate | BookmarkCandidate;

// Bodies never ride page queries; they travel through the body endpoint and direct open.
const applicationFeedItemColumns = { ...getTableColumns(feedItems) };
Reflect.deleteProperty(applicationFeedItemColumns, "normalizedUrl");
Reflect.deleteProperty(applicationFeedItemColumns, "content");

function bookmarkContentStatusCondition(contentStatus: ContentStatusFilter) {
  return and(
    eq(bookmarks.isSaved, contentStatus.saveStatus === "saved"),
    eq(bookmarks.isRead, contentStatus.archiveStatus === "archived"),
  );
}

function feedContentStatusCondition(contentStatus: ContentStatusFilter) {
  return and(
    eq(feedItems.isWatchLater, contentStatus.saveStatus === "saved"),
    eq(feedItems.isWatched, contentStatus.archiveStatus === "archived"),
  );
}

function bookmarkTimeExpression(contentStatus: ContentStatusFilter) {
  return selectContentStatusOrderValue(contentStatus, {
    published: sql<number>`${bookmarks.createdAt}`,
    saved: sql<number>`${bookmarks.savedUpdatedAt}`,
    archived: sql<number>`${bookmarks.readUpdatedAt}`,
  });
}

function feedTimeExpression(contentStatus: ContentStatusFilter) {
  return selectContentStatusOrderValue(contentStatus, {
    published: sql<number>`${feedItems.postedAt}`,
    saved: sql<number>`COALESCE(${feedItems.isWatchLaterUpdatedAt}, ${feedItems.postedAt})`,
    archived: sql<number>`COALESCE(${feedItems.isWatchedUpdatedAt}, ${feedItems.postedAt})`,
  });
}

function qualifiedColumn(table: unknown, column: { name: string }) {
  const tableName = (table as Record<symbol, string>)[
    Symbol.for("drizzle:Name")
  ];
  // Both identifiers come from static Drizzle schema metadata, not input.
  // react-doctor-disable-next-line react-doctor/raw-sql-injection-risk
  return sql.raw(`"${tableName}"."${column.name}"`);
}

function feedSectionPlacement(viewId: number) {
  const feedId = qualifiedColumn(feedItems, feedItems.feedId);
  return sql<number>`COALESCE(
    (
      SELECT MIN(placement)
      FROM serial_view_sections
      WHERE view_id = ${viewId}
        AND item_type = 'feed'
        AND item_id = ${feedId}
    ),
    (
      SELECT MIN(placement)
      FROM serial_view_sections AS candidate_section
      WHERE view_id = ${viewId}
        AND item_type = 'tag'
        AND EXISTS (
          SELECT 1
          FROM serial_feed_categories
          WHERE feed_id = ${feedId}
            AND category_id = candidate_section.item_id
        )
    ),
    ${UNCATEGORIZED_SECTION_PLACEMENT}
  )`;
}

function bookmarkSectionPlacement(viewId: number) {
  const bookmarkId = qualifiedColumn(bookmarks, bookmarks.id);
  return sql<number>`COALESCE(
    (
      SELECT MIN(candidate_section.placement)
      FROM serial_view_sections AS candidate_section
      INNER JOIN serial_bookmark_tag
        ON serial_bookmark_tag.tag_id = candidate_section.item_id
      WHERE candidate_section.view_id = ${viewId}
        AND candidate_section.item_type = 'tag'
        AND serial_bookmark_tag.bookmark_id = ${bookmarkId}
    ),
    ${UNCATEGORIZED_SECTION_PLACEMENT}
  )`;
}

function cursorCondition(input: {
  cursor: MixedContentCursor | undefined;
  placement: SQL<number>;
  normalizedAt: SQL<number>;
  entityKind: MixedContentEntityKind;
  entityId: typeof bookmarks.id | typeof feedItems.id;
  usesGlobalEntityIdTieBreak: boolean;
}) {
  const {
    cursor,
    placement,
    normalizedAt,
    entityKind,
    entityId,
    usesGlobalEntityIdTieBreak,
  } = input;
  if (!cursor) return undefined;
  const cursorPlacement = cursor.sectionPlacement ?? 0;
  const cursorTime = cursor.normalizedAt.getTime();
  const kindOrder = entityKind === "bookmark" ? 0 : 1;
  const cursorKindOrder = cursor.entityKind === "bookmark" ? 0 : 1;
  const idTie = usesGlobalEntityIdTieBreak
    ? or(
        lt(entityId, cursor.entityId),
        and(
          eq(entityId, cursor.entityId),
          kindOrder > cursorKindOrder ? sql`1` : sql`0`,
        ),
      )
    : kindOrder > cursorKindOrder
      ? sql`1`
      : kindOrder === cursorKindOrder
        ? lt(entityId, cursor.entityId)
        : sql`0`;
  return or(
    gt(placement, cursorPlacement),
    and(eq(placement, cursorPlacement), sql`${normalizedAt} < ${cursorTime}`),
    and(
      eq(placement, cursorPlacement),
      sql`${normalizedAt} = ${cursorTime}`,
      idTie,
    ),
  );
}

export async function queryBookmarkCandidates(input: {
  database: MixedContentDatabase;
  userId: string;
  scope: MixedContentScope;
  scopeData: ScopeData;
  contentStatus: ContentStatusFilter;
  sectionPlacement?: number | null;
  cursor?: MixedContentCursor;
  limit: number;
  usesSectionOrder: boolean;
  usesGlobalEntityIdTieBreak: boolean;
}): Promise<BookmarkCandidate[]> {
  const normalizedAt = bookmarkTimeExpression(input.contentStatus);
  const placement = input.usesSectionOrder
    ? bookmarkSectionPlacement((input.scope as { viewId: number }).viewId)
    : sql<number>`CAST(0 AS INTEGER)`;
  const rows = await input.database
    .select({ id: bookmarks.id, normalizedAt, placement })
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, input.userId),
        bookmarkContentStatusCondition(input.contentStatus),
        bookmarkScopeCondition(input),
        input.sectionPlacement === undefined || !input.usesSectionOrder
          ? undefined
          : eq(placement, input.sectionPlacement),
        cursorCondition({
          cursor: input.cursor,
          placement,
          normalizedAt,
          entityKind: "bookmark",
          entityId: bookmarks.id,
          usesGlobalEntityIdTieBreak: input.usesGlobalEntityIdTieBreak,
        }),
      ),
    )
    .orderBy(asc(placement), desc(normalizedAt), desc(bookmarks.id))
    .limit(input.limit + 1);
  return rows.map((row) => ({
    entityKind: "bookmark",
    entityId: row.id,
    sectionPlacement: input.usesSectionOrder ? row.placement : null,
    normalizedAt: new Date(row.normalizedAt),
  }));
}

export async function queryFeedCandidates(input: {
  database: MixedContentDatabase;
  userId: string;
  scope: MixedContentScope;
  scopeData: ScopeData;
  contentStatus: ContentStatusFilter;
  sectionPlacement?: number | null;
  cursor?: MixedContentCursor;
  limit: number;
  usesSectionOrder: boolean;
  usesGlobalEntityIdTieBreak: boolean;
}): Promise<FeedCandidate[]> {
  const normalizedAt = feedTimeExpression(input.contentStatus);
  const placement = input.usesSectionOrder
    ? feedSectionPlacement((input.scope as { viewId: number }).viewId)
    : sql<number>`CAST(0 AS INTEGER)`;
  const rows = await input.database
    .select({
      item: applicationFeedItemColumns,
      platform: feeds.platform,
      normalizedAt,
      placement,
    })
    .from(feedItems)
    .innerJoin(feeds, eq(feeds.id, feedItems.feedId))
    .where(
      and(
        eq(feeds.userId, input.userId),
        feedContentStatusCondition(input.contentStatus),
        feedScopeCondition(input),
        input.sectionPlacement === undefined || !input.usesSectionOrder
          ? undefined
          : eq(placement, input.sectionPlacement),
        cursorCondition({
          cursor: input.cursor,
          placement,
          normalizedAt,
          entityKind: "feed-item",
          entityId: feedItems.id,
          usesGlobalEntityIdTieBreak: input.usesGlobalEntityIdTieBreak,
        }),
      ),
    )
    .orderBy(asc(placement), desc(normalizedAt), desc(feedItems.id))
    .limit(input.limit + 1);
  return rows.map((row) => ({
    entityKind: "feed-item",
    entityId: row.item.id,
    item: {
      ...row.item,
      platform: row.platform,
      body: null,
    } as ApplicationFeedItem,
    sectionPlacement: input.usesSectionOrder ? row.placement : null,
    normalizedAt: new Date(row.normalizedAt),
  }));
}

export function compareCandidates(
  left: Candidate,
  right: Candidate,
  options: { usesGlobalEntityIdTieBreak?: boolean } = {},
) {
  const placementDifference =
    (left.sectionPlacement ?? 0) - (right.sectionPlacement ?? 0);
  if (placementDifference !== 0) return placementDifference;
  const timeDifference =
    right.normalizedAt.getTime() - left.normalizedAt.getTime();
  if (timeDifference !== 0) return timeDifference;
  if (options.usesGlobalEntityIdTieBreak) {
    return compareDescendingIdsThenKinds(
      left.entityId,
      right.entityId,
      left.entityKind,
      right.entityKind,
    );
  }
  const kindDifference = left.entityKind.localeCompare(right.entityKind);
  if (kindDifference !== 0) return kindDifference;
  return compareDescendingIds(left.entityId, right.entityId);
}
