import { and, eq, exists, inArray, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { db as defaultDatabase } from "~/server/db";
import type {
  ContentAvailability,
  ContentStatusFilter,
} from "~/lib/content-status";
import {
  INBOX_ARCHIVED_CONTENT_STATUS,
  INBOX_UNREAD_CONTENT_STATUS,
  SAVED_ARCHIVED_CONTENT_STATUS,
  SAVED_UNREAD_CONTENT_STATUS,
} from "~/lib/content-status";
import { UNCATEGORIZED_VIEW_ID } from "~/lib/data/views/constants";
import { TEXT_PLATFORMS, VIDEO_PLATFORMS } from "~/lib/content/descriptor";
import {
  CONTENT_FILTER_OPTION,
  contentFilterColumnAllowsDescriptor,
  contentFilterColumnHasOption,
} from "~/lib/views/contentFilter";
import {
  bookmarks,
  bookmarkTags,
  contentCategories,
  feedCategories,
  feedItems,
  feeds,
  viewCategories,
  viewFeeds,
  views,
} from "~/server/db/schema";
import { feedScopeCondition } from "~/server/mixed-content/projection/scope";

type NavigationDatabase = typeof defaultDatabase;
type SqlColumn = Parameters<typeof eq>[0];

export type NavigationAvailability = ContentAvailability;

export type NavigationSnapshot = {
  tags: Record<number, NavigationAvailability>;
  feeds: Record<number, NavigationAvailability>;
  viewFeeds: Record<number, Record<number, NavigationAvailability>>;
};

type AvailabilityRow = {
  id: number;
  inboxUnread: number;
  inboxArchived: number;
  savedUnread: number;
  savedArchived: number;
};

type ViewFeedAvailabilityRow = AvailabilityRow & {
  viewId: number;
  feedId: number;
};

function contentStatusCondition(input: {
  contentStatus: ContentStatusFilter;
  isRead: SqlColumn;
  isSaved: SqlColumn;
}) {
  return and(
    eq(input.isSaved, input.contentStatus.saveStatus === "saved"),
    eq(input.isRead, input.contentStatus.archiveStatus === "archived"),
  );
}

function hasAny(condition: SQL | undefined) {
  return sql<number>`CASE WHEN ${condition ?? sql`0`} THEN 1 ELSE 0 END`;
}

function availabilitySelection(
  contentStatusExists: (contentStatus: ContentStatusFilter) => SQL | undefined,
) {
  return {
    inboxUnread: hasAny(contentStatusExists(INBOX_UNREAD_CONTENT_STATUS)),
    inboxArchived: hasAny(contentStatusExists(INBOX_ARCHIVED_CONTENT_STATUS)),
    savedUnread: hasAny(contentStatusExists(SAVED_UNREAD_CONTENT_STATUS)),
    savedArchived: hasAny(contentStatusExists(SAVED_ARCHIVED_CONTENT_STATUS)),
  };
}

function availabilityRecord(rows: AvailabilityRow[]) {
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        inbox: {
          unread: Boolean(row.inboxUnread),
          archived: Boolean(row.inboxArchived),
        },
        saved: {
          unread: Boolean(row.savedUnread),
          archived: Boolean(row.savedArchived),
        },
      },
    ]),
  ) as Record<number, NavigationAvailability>;
}

function feedCompatibleWithView() {
  return or(
    and(
      inArray(feeds.platform, TEXT_PLATFORMS),
      contentFilterColumnHasOption(
        views.contentFilter,
        CONTENT_FILTER_OPTION.TEXT,
      ),
    ),
    and(
      inArray(feeds.platform, VIDEO_PLATFORMS),
      or(
        contentFilterColumnHasOption(
          views.contentFilter,
          CONTENT_FILTER_OPTION.VIDEOS,
        ),
        contentFilterColumnHasOption(
          views.contentFilter,
          CONTENT_FILTER_OPTION.SHORTS,
        ),
      ),
    ),
  );
}

function feedExistsForViewFeed(input: {
  database: NavigationDatabase;
  userId: string;
  contentStatus: ContentStatusFilter;
  now: Date;
}) {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const insideTimeWindow = or(
    eq(views.daysWindow, 0),
    sql`${feedItems.postedAt} >= (${nowSeconds} - (${views.daysWindow} * 86400))`,
  );

  return exists(
    input.database
      .select({ value: sql<number>`1` })
      .from(feedItems)
      .where(
        and(
          eq(feedItems.feedId, feeds.id),
          contentFilterColumnAllowsDescriptor({
            filter: views.contentFilter,
            contentType: feedItems.contentType,
            orientation: feedItems.orientation,
          }),
          insideTimeWindow,
          contentStatusCondition({
            contentStatus: input.contentStatus,
            isRead: feedItems.isWatched,
            isSaved: feedItems.isWatchLater,
          }),
        ),
      ),
  );
}

async function queryTagAvailability(input: {
  database: NavigationDatabase;
  userId: string;
}) {
  const feedExistsForTag = (contentStatus: ContentStatusFilter) =>
    exists(
      input.database
        .select({ value: sql<number>`1` })
        .from(feedCategories)
        .innerJoin(feeds, eq(feeds.id, feedCategories.feedId))
        .innerJoin(feedItems, eq(feedItems.feedId, feeds.id))
        .where(
          and(
            eq(feeds.userId, input.userId),
            eq(feedCategories.categoryId, contentCategories.id),
            contentStatusCondition({
              contentStatus,
              isRead: feedItems.isWatched,
              isSaved: feedItems.isWatchLater,
            }),
          ),
        ),
    );
  const bookmarkExistsForTag = (contentStatus: ContentStatusFilter) =>
    exists(
      input.database
        .select({ value: sql<number>`1` })
        .from(bookmarkTags)
        .innerJoin(bookmarks, eq(bookmarks.id, bookmarkTags.bookmarkId))
        .where(
          and(
            eq(bookmarks.userId, input.userId),
            eq(bookmarkTags.tagId, contentCategories.id),
            contentStatusCondition({
              contentStatus,
              isRead: bookmarks.isRead,
              isSaved: bookmarks.isSaved,
            }),
          ),
        ),
    );
  const contentStatusExists = (contentStatus: ContentStatusFilter) =>
    or(feedExistsForTag(contentStatus), bookmarkExistsForTag(contentStatus));

  const rows = await input.database
    .select({
      id: contentCategories.id,
      ...availabilitySelection(contentStatusExists),
    })
    .from(contentCategories)
    .where(eq(contentCategories.userId, input.userId));
  return availabilityRecord(rows);
}

async function queryViewIds(input: {
  database: NavigationDatabase;
  userId: string;
}) {
  const rows = await input.database
    .select({ id: views.id })
    .from(views)
    .where(eq(views.userId, input.userId));
  return [UNCATEGORIZED_VIEW_ID, ...rows.map(({ id }) => id)];
}

async function queryFeedAvailability(input: {
  database: NavigationDatabase;
  userId: string;
}) {
  const contentStatusExists = (contentStatus: ContentStatusFilter) =>
    exists(
      input.database
        .select({ value: sql<number>`1` })
        .from(feedItems)
        .where(
          and(
            eq(feedItems.feedId, feeds.id),
            contentStatusCondition({
              contentStatus,
              isRead: feedItems.isWatched,
              isSaved: feedItems.isWatchLater,
            }),
          ),
        ),
    );
  const rows = await input.database
    .select({
      id: feeds.id,
      ...availabilitySelection(contentStatusExists),
    })
    .from(feeds)
    .where(eq(feeds.userId, input.userId));
  return availabilityRecord(rows);
}

function buildUncategorizedScope(database: NavigationDatabase, userId: string) {
  return {
    database,
    userId,
    scope: { type: "view" as const, viewId: UNCATEGORIZED_VIEW_ID },
    scopeData: {
      valid: true,
      targetView: null,
      categoryIds: [],
      directFeedIds: [],
      sections: [],
    },
  };
}

async function queryCustomViewFeedAvailability(input: {
  database: NavigationDatabase;
  userId: string;
  now: Date;
}) {
  const directMembership = exists(
    input.database
      .select({ value: sql<number>`1` })
      .from(viewFeeds)
      .where(
        and(eq(viewFeeds.viewId, views.id), eq(viewFeeds.feedId, feeds.id)),
      ),
  );
  const tagMembership = exists(
    input.database
      .select({ value: sql<number>`1` })
      .from(feedCategories)
      .innerJoin(
        viewCategories,
        eq(viewCategories.categoryId, feedCategories.categoryId),
      )
      .where(
        and(
          eq(viewCategories.viewId, views.id),
          eq(feedCategories.feedId, feeds.id),
        ),
      ),
  );
  const hasConfiguredMembership = or(
    exists(
      input.database
        .select({ value: sql<number>`1` })
        .from(viewFeeds)
        .where(eq(viewFeeds.viewId, views.id)),
    ),
    exists(
      input.database
        .select({ value: sql<number>`1` })
        .from(viewCategories)
        .where(eq(viewCategories.viewId, views.id)),
    ),
  );
  const belongsToView = or(
    directMembership,
    and(
      feedCompatibleWithView(),
      or(tagMembership, not(hasConfiguredMembership ?? sql`0`)),
    ),
  );
  const contentStatusExists = (contentStatus: ContentStatusFilter) =>
    feedExistsForViewFeed({ ...input, contentStatus });

  return input.database
    .select({
      id: feeds.id,
      viewId: views.id,
      feedId: feeds.id,
      ...availabilitySelection(contentStatusExists),
    })
    .from(views)
    .innerJoin(feeds, and(eq(feeds.userId, input.userId), belongsToView))
    .where(eq(views.userId, input.userId));
}

async function queryUncategorizedViewFeedAvailability(input: {
  database: NavigationDatabase;
  userId: string;
}) {
  const uncategorizedScope = buildUncategorizedScope(
    input.database,
    input.userId,
  );
  const contentStatusExists = (contentStatus: ContentStatusFilter) =>
    exists(
      input.database
        .select({ value: sql<number>`1` })
        .from(feedItems)
        .where(
          and(
            eq(feedItems.feedId, feeds.id),
            contentStatusCondition({
              contentStatus,
              isRead: feedItems.isWatched,
              isSaved: feedItems.isWatchLater,
            }),
          ),
        ),
    );

  return input.database
    .select({
      id: feeds.id,
      viewId: sql<number>`${UNCATEGORIZED_VIEW_ID}`,
      feedId: feeds.id,
      ...availabilitySelection(contentStatusExists),
    })
    .from(feeds)
    .where(
      and(
        eq(feeds.userId, input.userId),
        feedScopeCondition(uncategorizedScope),
      ),
    );
}

function viewFeedAvailabilityRecord(
  viewIds: number[],
  rows: ViewFeedAvailabilityRow[],
) {
  const result: Record<
    number,
    Record<number, NavigationAvailability>
  > = Object.fromEntries(viewIds.map((viewId) => [viewId, {}]));

  for (const row of rows) {
    result[row.viewId] ??= {};
    result[row.viewId]![row.feedId] = {
      inbox: {
        unread: Boolean(row.inboxUnread),
        archived: Boolean(row.inboxArchived),
      },
      saved: {
        unread: Boolean(row.savedUnread),
        archived: Boolean(row.savedArchived),
      },
    };
  }
  return result;
}

export async function queryNavigationSnapshot(input: {
  database: NavigationDatabase;
  userId: string;
  now?: Date;
}): Promise<NavigationSnapshot> {
  const now = input.now ?? new Date();
  const [
    viewIds,
    tagAvailability,
    feedAvailability,
    customViewFeedAvailability,
    uncategorizedViewFeedAvailability,
  ] = await Promise.all([
    queryViewIds(input),
    queryTagAvailability(input),
    queryFeedAvailability(input),
    queryCustomViewFeedAvailability({ ...input, now }),
    queryUncategorizedViewFeedAvailability(input),
  ]);
  return {
    tags: tagAvailability,
    feeds: feedAvailability,
    viewFeeds: viewFeedAvailabilityRecord(viewIds, [
      ...customViewFeedAvailability,
      ...uncategorizedViewFeedAvailability,
    ]),
  };
}
