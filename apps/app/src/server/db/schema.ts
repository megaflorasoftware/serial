// Example model schema from the Drizzle docs
// https://orm.drizzle.team/docs/sql-schema-declaration

import { createId } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
  blob,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTableCreator,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import {
  VIEW_LAYOUT,
  VIEW_LAYOUT_ITEM_TYPE,
  VIEW_READ_STATUS,
  viewLayoutItemTypeSchema,
  viewLayoutSchema,
  viewReadStatusSchema,
} from "./constants";
import type { ReaderBody } from "@serial/standard-site";
import type { PublicationSyncResult } from "~/lib/auth/publication-sync";
import type { ItemObservation } from "./feed-item-observation";
import type { ContentPlatform } from "~/lib/content/descriptor";
import {
  CONTENT_PLATFORM,
  CONTENT_TYPE,
  contentPlatformSchema,
  contentTypeSchema,
  OBSERVATION_SOURCE,
  observationSourceSchema,
  videoOrientationSchema,
} from "~/lib/content/descriptor";
import {
  contentFilterSchema,
  DEFAULT_CONTENT_FILTER,
} from "~/lib/views/contentFilter";
import {
  boundedNumberIdsSchema,
  MAX_BULK_MUTATION_ITEMS,
} from "~/lib/schemas/bulk";

/**
 * This is an example of how to use the multi-project schema feature of Drizzle ORM. Use the same
 * database instance for multiple projects.
 *
 * @see https://orm.drizzle.team/docs/goodies#multi-project-schema
 */
export const sqliteTable = sqliteTableCreator((name) => `serial_${name}`);

// === Start: Better Auth ===
export const user = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
    // Policy bit, not proof of address ownership: true means this user is not
    // required to verify their email (identity-provider-provisioned accounts).
    // Maintained by the account-creation hook in src/server/auth/index.tsx.
    emailVerificationExempt: integer("email_verification_exempt", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    onboardingComplete: integer("onboarding_complete", { mode: "boolean" })
      .notNull()
      .default(false),
    onboardingStep: text("onboarding_step"),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    role: text("role"),
    banned: integer("banned", { mode: "boolean" }).default(false),
    banReason: text("ban_reason"),
    banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
    nextRefreshAt: integer("next_refresh_at", { mode: "timestamp" }),
    lastActiveAt: integer("last_active_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("user_created_at_idx").on(table.createdAt),
    index("user_next_refresh_at_idx").on(table.nextRefreshAt),
  ],
);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [
    index("session_user_id_idx").on(table.userId),
    index("session_created_at_idx").on(table.createdAt),
  ],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

export const extensionSession = sqliteTable(
  "extension_session",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    index("extension_session_user_id_idx").on(table.userId),
    index("extension_session_expires_at_idx").on(table.expiresAt),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  extensionSessions: many(extensionSession),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const extensionSessionRelations = relations(
  extensionSession,
  ({ one }) => ({
    user: one(user, {
      fields: [extensionSession.userId],
      references: [user.id],
    }),
  }),
);

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const invitation = sqliteTable(
  "invitation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name"), // optional human-readable label
    token: text("token").notNull().unique(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // "active" | "disabled"
    maxUses: integer("max_uses"), // null = unlimited
    expiresAt: integer("expires_at", { mode: "timestamp" }), // null = never expires
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [index("invitation_inviter_id_idx").on(table.inviterId)],
);

export const invitationRedemption = sqliteTable(
  "invitation_redemption",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => invitation.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    index("invitation_redemption_invitation_id_idx").on(table.invitationId),
  ],
);

// === End: Better Auth ===

export const feeds = sqliteTable(
  "feed",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name", { length: 256 }).notNull().default(""),
    imageUrl: text("image_url", { length: 512 }).notNull().default(""),
    platform: text("platform", { length: 256 }).notNull().default("youtube"),
    openLocation: text("open_location", { length: 64 })
      .notNull()
      .default("serial"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    // Canonical site the Feed subscribes to; null until an origin reports one.
    siteUrl: text("site_url", { length: 512 }),
    // Set when the user renames the Feed so derived names never overwrite it.
    nameEditedAt: integer("name_edited_at", { mode: "timestamp" }),
  },
  (example) => [
    index("feed_user_id_idx").on(example.userId),
    index("feed_user_id_is_active_idx").on(example.userId, example.isActive),
  ],
);

export const FEED_ORIGIN_KIND = {
  RSS: "rss",
  ATPROTO: "atproto",
} as const;
export const feedOriginKindSchema = z.enum([
  FEED_ORIGIN_KIND.RSS,
  FEED_ORIGIN_KIND.ATPROTO,
]);
export type FeedOriginKind = z.infer<typeof feedOriginKindSchema>;

/**
 * One data source of a Feed. An RSS origin is located by its feed URL; an
 * Atmosphere origin by a publication at-uri. Scheduling and observed source metadata live here so each origin keeps its
 * own clock. `userId` is denormalised so the due-origin pager never joins
 * before filtering.
 */
export const feedOrigins = sqliteTable(
  "feed_origin",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { length: 16 }).notNull(),
    locator: text("locator", { length: 1024 }).notNull(),
    lastFetchedAt: integer("last_fetched_at", { mode: "timestamp" }),
    nextFetchAt: integer("next_fetch_at", { mode: "timestamp" }),
    // Metadata as observed from the source on the last successful read.
    sourceName: text("source_name", { length: 256 }),
    sourceImageUrl: text("source_image_url", { length: 512 }),
    sourceDescription: text("source_description"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("feed_origin_feed_id_kind_unique").on(table.feedId, table.kind),
    index("feed_origin_kind_locator_idx").on(table.kind, table.locator),
    index("feed_origin_user_id_kind_locator_idx").on(
      table.userId,
      table.kind,
      table.locator,
    ),
    index("feed_origin_user_id_next_fetch_at_idx").on(
      table.userId,
      table.nextFetchAt,
    ),
  ],
);
export const feedOriginSchema = createSelectSchema(feedOrigins).merge(
  z.object({ kind: feedOriginKindSchema }),
);
export type DatabaseFeedOrigin = typeof feedOrigins.$inferSelect;
export type ApplicationFeedOrigin = z.infer<typeof feedOriginSchema>;
export const openLocationSchema = z.enum(["serial", "origin"]);
export type FeedOpenLocation = z.infer<typeof openLocationSchema>;

export const PLATFORM_DEFAULT_OPEN_LOCATION: Partial<
  Record<ContentPlatform, FeedOpenLocation>
> = {
  nebula: "origin",
};

export const feedsSchema = createSelectSchema(feeds).merge(
  z.object({
    platform: contentPlatformSchema,
    openLocation: openLocationSchema,
    origins: feedOriginSchema.array(),
  }),
);
export type DatabaseFeed = typeof feeds.$inferSelect;
/** A Feed row with its origin rows attached, the shape every Feed read returns. */
export type DatabaseFeedWithOrigins = DatabaseFeed & {
  origins: HydratedFeedOrigin[];
};
export type ApplicationFeed = z.infer<typeof feedsSchema>;

export const feedOriginRss = sqliteTable("feed_origin_rss", {
  originId: integer("origin_id")
    .primaryKey()
    .references(() => feedOrigins.id, { onDelete: "cascade" }),
  etag: text("etag"),
  lastModifiedHeader: text("last_modified_header"),
  alternateLocators: text("alternate_locators", { mode: "json" }).$type<
    string[]
  >(),
});

export const feedOriginAtproto = sqliteTable(
  "feed_origin_atproto",
  {
    originId: integer("origin_id")
      .primaryKey()
      .references(() => feedOrigins.id, { onDelete: "cascade" }),
    publicationDid: text("publication_did").notNull(),
    workOwner: text("work_owner"),
    workUntil: integer("work_until", { mode: "timestamp_ms" }),
    recoveryRetryAt: integer("recovery_retry_at", { mode: "timestamp_ms" }),
    recoveryAttempts: integer("recovery_attempts").notNull().default(0),
    streamService: text("stream_service"),
    streamSeq: text("stream_seq"),
    streamGeneration: integer("stream_generation").notNull().default(0),
    streamMode: text("stream_mode", {
      enum: ["paused", "direct", "catchup", "live"],
    })
      .notNull()
      .default("paused"),
    publicationRecord: text("publication_record", {
      mode: "json",
    }).$type<unknown>(),
    publicationSeq: text("publication_seq"),
    publicationDirty: integer("publication_dirty", { mode: "boolean" })
      .notNull()
      .default(false),
    accountSeq: text("account_seq"),
    accountStatus: text("account_status"),
    repositorySeq: text("repository_seq"),
    repositoryRev: text("repository_rev"),
    repositoryActive: integer("repository_active", { mode: "boolean" })
      .notNull()
      .default(true),
    identitySeq: text("identity_seq"),
    listingEtag: text("listing_etag"),
    cursor: text("cursor"),
    boundary: text("boundary"),
    newestRkey: text("newest_rkey"),
    initialCount: integer("initial_count").notNull().default(0),
    initialized: integer("initialized", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    index("feed_origin_atproto_publication_did_idx").on(table.publicationDid),
  ],
);

/** Server-only details; the application schema exposes only the common origin. */
export type HydratedFeedOrigin = DatabaseFeedOrigin & {
  rss: typeof feedOriginRss.$inferSelect | null;
  atproto: typeof feedOriginAtproto.$inferSelect | null;
};

/** One configured service. Sequences are exact decimal text, never floating-point SQL values. */
export const atprotoStreamState = sqliteTable("atproto_stream_state", {
  id: text("id").primaryKey(),
  service: text("service").notNull(),
  seq: text("seq"),
  generation: integer("generation").notNull().default(0),
  connected: integer("connected", { mode: "boolean" }).notNull().default(false),
  leaseOwner: text("lease_owner"),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
});

export const DOCUMENT_LEDGER_REASONS = [
  "invalid",
  "oversized",
  "adapter",
] as const;

/**
 * Work ledger per document. It never carries record data: the Document source
 * lives in its own rows so due-work scans stay narrow.
 */
export const feedOriginAtprotoDocuments = sqliteTable(
  "feed_origin_atproto_document",
  {
    originId: integer("origin_id")
      .notNull()
      .references(() => feedOriginAtproto.originId, { onDelete: "cascade" }),
    uri: text("uri").notNull(),
    cid: text("cid").notNull(),
    status: text("status", {
      enum: ["ready", "retry", "invalid", "deleted"],
    }).notNull(),
    eventSeq: text("event_seq"),
    eventRev: text("event_rev"),
    /** The source version underlying the last readable body; never replaced by a failed import. */
    bodyCid: text("body_cid"),
    reason: text("reason", { enum: DOCUMENT_LEDGER_REASONS }),
    retryAt: integer("retry_at", { mode: "timestamp_ms" }),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.originId, table.uri] }),
    // Pending work drains fresh-first, newest-first; the index serves that order.
    index("feed_origin_atproto_document_due_idx").on(
      table.originId,
      table.status,
      table.retryAt,
      sql`${table.uri} desc`,
    ),
  ],
);

/** The record as the platform wrote it, as lossless JSON text, per Feed and version. */
export const feedOriginAtprotoDocumentSources = sqliteTable(
  "feed_origin_atproto_document_source",
  {
    originId: integer("origin_id").notNull(),
    uri: text("uri").notNull(),
    cid: text("cid").notNull(),
    record: text("record").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.originId, table.uri, table.cid] }),
    foreignKey({
      columns: [table.originId, table.uri],
      foreignColumns: [
        feedOriginAtprotoDocuments.originId,
        feedOriginAtprotoDocuments.uri,
      ],
      name: "feed_origin_atproto_document_source_document_fk",
    }).onDelete("cascade"),
  ],
);

/** Overflow blob bytes fetched during import, exactly as served, keyed by the source version. */
export const feedOriginAtprotoDocumentBlobs = sqliteTable(
  "feed_origin_atproto_document_blob",
  {
    originId: integer("origin_id").notNull(),
    uri: text("uri").notNull(),
    cid: text("cid").notNull(),
    blobCid: text("blob_cid").notNull(),
    mimeType: text("mime_type"),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.originId, table.uri, table.cid, table.blobCid],
    }),
    foreignKey({
      columns: [table.originId, table.uri, table.cid],
      foreignColumns: [
        feedOriginAtprotoDocumentSources.originId,
        feedOriginAtprotoDocumentSources.uri,
        feedOriginAtprotoDocumentSources.cid,
      ],
      name: "feed_origin_atproto_document_blob_source_fk",
    }).onDelete("cascade"),
  ],
);

/** The last state resolved for a referenced record, shared by every document that refers to it. */
export const atprotoReferenceSnapshots = sqliteTable(
  "atproto_reference_snapshot",
  {
    uri: text("uri").primaryKey(),
    cid: text("cid"),
    outcome: text("outcome", {
      enum: ["resolved", "missing", "unsupported", "unavailable"],
    }).notNull(),
    record: text("record"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }).notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("atproto_reference_snapshot_read_at_idx").on(table.readAt)],
);

export const feedItems = sqliteTable(
  "feed_item",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    contentId: text("content_id", { length: 512 }).notNull(),
    title: text("title", { length: 512 }).notNull(),
    author: text("author", { length: 512 }).notNull(),
    url: text("url", { length: 512 }).notNull(),
    // Stored only when production URL normalization changes the Feed URL.
    // Most rows remain null and compare through COALESCE(normalizedUrl, url).
    normalizedUrl: text("normalized_url", { length: 4096 }),
    thumbnail: text("thumbnail", { length: 512 }).notNull().default(""),
    content: text("content").notNull().default(""),
    contentSnippet: text("content_snippet").notNull().default(""),
    contentType: text("content_type", {
      enum: [CONTENT_TYPE.TEXT, CONTENT_TYPE.VIDEO],
    })
      .notNull()
      .default(CONTENT_TYPE.TEXT),
    isWatched: integer("is_watched", { mode: "boolean" })
      .notNull()
      .default(false),
    isWatchLater: integer("is_watch_later", { mode: "boolean" })
      .notNull()
      .default(false),
    progress: integer("progress", { mode: "number" }).notNull().default(0),
    duration: integer("duration", { mode: "number" }).notNull().default(0),
    orientation: text("orientation", { length: 64 }),
    postedAt: integer("posted_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    isWatchedUpdatedAt: integer("is_watched_updated_at", { mode: "timestamp" }),
    isWatchLaterUpdatedAt: integer("is_watch_later_updated_at", {
      mode: "timestamp",
    }),
    contentHash: text("content_hash"),
    sourceKind: text("source_kind", { enum: ["rss", "atproto", "both"] })
      .notNull()
      .default("rss"),
    atprotoUri: text("atproto_uri"),
    bodySource: text("body_source", { enum: ["rss", "atproto", "none"] })
      .notNull()
      .default("none"),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    /** Set when the Reader body is a Document source; the body revision for clients. */
    sourceCid: text("source_cid"),
  },
  (example) => [
    unique().on(example.url, example.feedId),
    index("feed_item_feed_normalized_url_idx").on(
      example.feedId,
      example.normalizedUrl,
    ),
    unique("feed_item_feed_atproto_uri_unique").on(
      example.feedId,
      example.atprotoUri,
    ),
    index("feed_item_feed_id_posted_at_idx").on(
      example.feedId,
      example.postedAt,
    ),
    // Composite index for the main view-diff queries:
    //   WHERE feed_id IN (...) AND is_watched = ? AND is_watch_later = ?
    //   ORDER BY posted_at DESC LIMIT 31
    // Lets SQLite seek directly to (feedId, isWatched, isWatchLater) and
    // scan posted_at in order — avoids scanning/sorting watched items.
    index("feed_item_feed_id_visibility_posted_at_idx").on(
      example.feedId,
      example.isWatched,
      example.isWatchLater,
      example.postedAt,
    ),
    // Covers Saved content ordered by its save-state update time.
    // without constraining isWatched, so it can't use the wider composite.
    index("feed_item_feed_id_is_watch_later_posted_at_idx").on(
      example.feedId,
      example.isWatchLater,
      example.postedAt,
    ),
    // Covers Archived content ordered by its archive-state update time.
    index("feed_item_feed_id_is_watched_updated_at_idx").on(
      example.feedId,
      example.isWatched,
      example.isWatchedUpdatedAt,
    ),
  ],
);
/** Internal source snapshots allow edits to restore the other origin's fallback. */
export const feedItemObservations = sqliteTable(
  "feed_item_observation",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["rss", "atproto"] }).notNull(),
    value: text("value", { mode: "json" }).$type<ItemObservation>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.kind] })],
);

/** Old URLs remain aliases after an edit so stale RSS cannot recreate a duplicate. */
export const feedItemAliases = sqliteTable(
  "feed_item_alias",
  {
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    locator: text("locator").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => feedItems.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.feedId, table.locator] }),
    index("feed_item_alias_item_idx").on(table.itemId),
  ],
);

export const feedItemSchema = createSelectSchema(feedItems);
export type DatabaseFeedItem = typeof feedItems.$inferSelect;

export const applicationFeedItemSchema = feedItemSchema
  .omit({ normalizedUrl: true, content: true })
  .merge(
    z.object({
      platform: contentPlatformSchema,
      contentType: contentTypeSchema,
      orientation: videoOrientationSchema.nullable(),
      /** Null until loaded through the body endpoint or a direct open; typed, not parsed, at this boundary. */
      body: z.custom<ReaderBody>().nullable(),
    }),
  )
  .required();
export type ApplicationFeedItem = z.infer<typeof applicationFeedItemSchema>;

export const contentCategories = sqliteTable(
  "content_categories",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name", { length: 256 }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (example) => [
    index("content_categories_user_id_name_idx").on(
      example.userId,
      example.name,
    ),
  ],
);
export const contentCategorySchema = createSelectSchema(contentCategories);
export type DatabaseContentCategory = typeof contentCategories.$inferSelect;

export const feedCategories = sqliteTable(
  "feed_categories",
  {
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => contentCategories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.feedId, table.categoryId] }),
    index("feed_categories_category_id_idx").on(table.categoryId),
  ],
);
export const feedCategorySchema = createSelectSchema(feedCategories);
export type DatabaseFeedCategory = typeof feedCategories.$inferSelect;

// === Bookmarks ===

export const bookmarks = sqliteTable(
  "bookmark",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    effectiveUrl: text("effective_url").notNull().default(""),
    canonicalUrl: text("canonical_url").notNull(),
    platform: text("platform", {
      enum: [
        CONTENT_PLATFORM.WEBSITE,
        CONTENT_PLATFORM.YOUTUBE,
        CONTENT_PLATFORM.PEERTUBE,
        CONTENT_PLATFORM.NEBULA,
      ],
    })
      .notNull()
      .default(CONTENT_PLATFORM.WEBSITE),
    contentType: text("content_type", {
      enum: [CONTENT_TYPE.TEXT, CONTENT_TYPE.VIDEO],
    })
      .notNull()
      .default(CONTENT_TYPE.TEXT),
    orientation: text("orientation", {
      enum: ["horizontal", "vertical"],
    }),
    contentId: text("content_id"),
    classificationSource: text("classification_source", {
      enum: [
        OBSERVATION_SOURCE.EXTENSION_LIVE_DOM,
        OBSERVATION_SOURCE.SERVER_STATIC_FETCH,
        OBSERVATION_SOURCE.URL,
      ],
    })
      .notNull()
      .default(OBSERVATION_SOURCE.URL),
    classifierVersion: integer("classifier_version").notNull().default(1),
    title: text("title").notNull().default(""),
    description: text("description"),
    author: text("author"),
    siteName: text("site_name"),
    publishedAt: integer("published_at", { mode: "timestamp" }),
    thumbnailUrl: text("thumbnail_url"),
    iconUrl: text("icon_url"),
    previewSource: text("preview_source", {
      enum: [
        OBSERVATION_SOURCE.EXTENSION_LIVE_DOM,
        OBSERVATION_SOURCE.SERVER_STATIC_FETCH,
        OBSERVATION_SOURCE.URL,
      ],
    })
      .notNull()
      .default(OBSERVATION_SOURCE.URL),
    isSaved: integer("is_saved", { mode: "boolean" }).notNull().default(true),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    progress: integer("progress", { mode: "number" }).notNull().default(0),
    duration: integer("duration", { mode: "number" }).notNull().default(0),
    savedUpdatedAt: integer("saved_updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    readUpdatedAt: integer("read_updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    progressUpdatedAt: integer("progress_updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("bookmark_user_id_canonical_url_unique").on(
      table.userId,
      table.canonicalUrl,
    ),
    unique("bookmark_user_id_platform_content_id_unique").on(
      table.userId,
      table.platform,
      table.contentId,
    ),
    index("bookmark_user_id_idx").on(table.userId),
    index("bookmark_user_saved_saved_at_idx").on(
      table.userId,
      table.isSaved,
      table.savedUpdatedAt,
      table.id,
    ),
    index("bookmark_user_saved_read_read_at_idx").on(
      table.userId,
      table.isSaved,
      table.isRead,
      table.readUpdatedAt,
      table.id,
    ),
    index("bookmark_user_saved_read_created_at_idx").on(
      table.userId,
      table.isSaved,
      table.isRead,
      table.createdAt,
      table.id,
    ),
  ],
);

export const pageCaptures = sqliteTable("page_capture", {
  bookmarkId: text("bookmark_id")
    .primaryKey()
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  contentHtml: text("content_html").notNull(),
  contentHash: text("content_hash").notNull(),
  captureSource: text("capture_source", {
    enum: ["extension-live-dom", "server-static-fetch"],
  }).notNull(),
  extractorVersion: text("extractor_version").notNull(),
  sanitizerPolicyVersion: integer("sanitizer_policy_version").notNull(),
  capturedAt: integer("captured_at", { mode: "timestamp" })
    .$default(() => new Date())
    .notNull(),
});

export const bookmarkSchema = createSelectSchema(bookmarks).merge(
  z.object({
    platform: contentPlatformSchema,
    contentType: contentTypeSchema,
    orientation: videoOrientationSchema.nullable(),
    classificationSource: observationSourceSchema,
    previewSource: observationSourceSchema,
  }),
);
export const pageCaptureSchema = createSelectSchema(pageCaptures);
export type DatabaseBookmark = typeof bookmarks.$inferSelect;
export type DatabasePageCapture = typeof pageCaptures.$inferSelect;

export const userConfig = sqliteTable("user_config", {
  id: text("id")
    .primaryKey()
    .$default(() => createId()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$default(() => new Date())
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$default(() => new Date())
    .notNull(),
  lightHSL: text("light_hsl", { length: 16 }).notNull().default(""),
  darkHSL: text("dark_hsl", { length: 16 }).notNull().default(""),
  articleFontSize: integer("article_font_size"),
  articleFontFamily: text("article_font_family", { length: 64 }),
});
export type DatabaseUserConfig = typeof userConfig.$inferSelect;

export const views = sqliteTable(
  "views",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name", { length: 256 }).notNull().default(""),
    daysWindow: integer("days_window", { mode: "number" }).notNull().default(0),
    readStatus: integer("read_status", { mode: "number" })
      .notNull()
      .default(VIEW_READ_STATUS.UNREAD),
    contentFilter: integer("content_filter", { mode: "number" })
      .notNull()
      .default(DEFAULT_CONTENT_FILTER),
    layout: text("layout", { length: 32 }).notNull().default(VIEW_LAYOUT.LIST),
    placement: integer("placement", { mode: "number" }).notNull().default(-1),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (example) => [
    index("view_user_id_idx").on(example.userId),
    index("view_user_id_placement_idx").on(example.userId, example.placement),
  ],
);

export const viewSchema = createSelectSchema(views).merge(
  z.object({ contentFilter: contentFilterSchema }),
);
export type DatabaseView = typeof views.$inferSelect;

export const viewSections = sqliteTable(
  "view_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    viewId: integer("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
    placement: integer("placement", { mode: "number" }).notNull(),
    itemType: text("item_type", { length: 16 })
      .notNull()
      .default(VIEW_LAYOUT_ITEM_TYPE.FEED),
    itemId: integer("item_id", { mode: "number" }).notNull(),
    layout: text("layout", { length: 32 }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    index("view_sections_view_id_idx").on(table.viewId),
    index("view_sections_view_id_placement_idx").on(
      table.viewId,
      table.placement,
    ),
  ],
);
export type DatabaseViewSection = typeof viewSections.$inferSelect;

export const viewSectionSchema = createSelectSchema(viewSections).merge(
  z.object({
    itemType: viewLayoutItemTypeSchema,
  }),
);
export type ApplicationViewSection = z.infer<typeof viewSectionSchema>;

export const applicationViewSchema = createInsertSchema(views)
  .merge(
    z.object({
      categoryIds: z.array(z.number()),
      feedIds: z.array(z.number()),
      isDefault: z.boolean(),
      viewSections: z.array(viewSectionSchema),
    }),
  )
  .required();
export type ApplicationView = z.infer<typeof applicationViewSchema>;

export const viewCategories = sqliteTable(
  "view_categories",
  {
    viewId: integer("view_id").references(() => views.id, {
      onDelete: "cascade",
    }),
    categoryId: integer("category_id").references(() => contentCategories.id, {
      onDelete: "cascade",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.viewId, table.categoryId] }),
    index("view_categories_view_id_idx").on(table.viewId),
    index("view_categories_category_id_idx").on(table.categoryId),
  ],
);
export type DatabaseViewCategory = typeof viewCategories.$inferSelect;

export const viewFeeds = sqliteTable(
  "view_feeds",
  {
    viewId: integer("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
    feedId: integer("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.viewId, table.feedId] }),
    index("view_feeds_view_id_idx").on(table.viewId),
    index("view_feeds_feed_id_idx").on(table.feedId),
  ],
);
export type DatabaseViewFeed = typeof viewFeeds.$inferSelect;

export const bookmarkViews = sqliteTable(
  "bookmark_view",
  {
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    viewId: integer("view_id")
      .notNull()
      .references(() => views.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.bookmarkId, table.viewId] }),
    index("bookmark_view_view_id_idx").on(table.viewId),
  ],
);

export const bookmarkTags = sqliteTable(
  "bookmark_tag",
  {
    bookmarkId: text("bookmark_id")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => contentCategories.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.bookmarkId, table.tagId] }),
    index("bookmark_tag_tag_id_idx").on(table.tagId),
  ],
);

export const bookmarkRelations = relations(bookmarks, ({ one, many }) => ({
  user: one(user, {
    fields: [bookmarks.userId],
    references: [user.id],
  }),
  capture: one(pageCaptures),
  views: many(bookmarkViews),
  tags: many(bookmarkTags),
}));

export const pageCaptureRelations = relations(pageCaptures, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [pageCaptures.bookmarkId],
    references: [bookmarks.id],
  }),
}));

export const bookmarkViewRelations = relations(bookmarkViews, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [bookmarkViews.bookmarkId],
    references: [bookmarks.id],
  }),
  view: one(views, {
    fields: [bookmarkViews.viewId],
    references: [views.id],
  }),
}));

export const bookmarkTagRelations = relations(bookmarkTags, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [bookmarkTags.bookmarkId],
    references: [bookmarks.id],
  }),
  tag: one(contentCategories, {
    fields: [bookmarkTags.tagId],
    references: [contentCategories.id],
  }),
}));

export type DatabaseBookmarkView = typeof bookmarkViews.$inferSelect;
export type DatabaseBookmarkTag = typeof bookmarkTags.$inferSelect;

export const viewSectionInputSchema = z.object({
  placement: z.number(),
  itemType: viewLayoutItemTypeSchema,
  itemId: z.number(),
  layout: viewLayoutSchema.optional().nullable(),
});

export const createViewSchema = createInsertSchema(views)
  .omit({ userId: true })
  .merge(
    z.object({
      readStatus: viewReadStatusSchema.optional(),
      contentFilter: contentFilterSchema.optional(),
      layout: viewLayoutSchema.optional(),
      daysWindow: z.number().lte(30).optional(),
      placement: z.number().gte(-1).optional(),
      categoryIds: boundedNumberIdsSchema.optional(),
      feedIds: boundedNumberIdsSchema.optional(),
      viewSections: z
        .array(viewSectionInputSchema)
        .max(MAX_BULK_MUTATION_ITEMS)
        .optional(),
    }),
  );

export const updateViewSchema = createUpdateSchema(views).merge(
  z.object({
    id: z.number(),
    categoryIds: boundedNumberIdsSchema,
    feedIds: boundedNumberIdsSchema,
    contentFilter: contentFilterSchema.optional(),
    layout: viewLayoutSchema.optional(),
    viewSections: z
      .array(viewSectionInputSchema)
      .max(MAX_BULK_MUTATION_ITEMS)
      .optional(),
  }),
);

export const deleteViewSchema = z.object({
  id: z.number(),
});

// === Instapaper OAuth 1.0a Connections ===
export const instapaperConnections = sqliteTable("instapaper_connections", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  username: text("username").notNull(),
  oauthToken: text("oauth_token").notNull(),
  oauthTokenSecret: text("oauth_token_secret").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .$default(() => new Date())
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$default(() => new Date())
    .notNull(),
});
export type DatabaseInstapaperConnection =
  typeof instapaperConnections.$inferSelect;

// === AT Protocol OAuth ===

/**
 * In-flight AT Protocol authorization attempts, keyed by the OAuth `state`
 * parameter. The payload is an encrypted envelope (see server/auth/atproto)
 * holding the SDK's saved state: PKCE verifier, DPoP private key, issuer.
 * Rows are single-use — consumed at callback — and expire within the hour.
 */
export const atprotoAuthState = sqliteTable(
  "atproto_auth_state",
  {
    key: text("key").primaryKey(),
    payload: text("payload").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [index("atproto_auth_state_expires_at_idx").on(table.expiresAt)],
);

/**
 * Durable AT Protocol connections, keyed by DID. The `session` column is an
 * encrypted envelope holding the SDK's saved OAuth session (access + refresh
 * tokens and the DPoP private key); everything else is plaintext display and
 * bookkeeping data so no read path needs to decrypt. `userId` is null between
 * the OAuth callback persisting the session and the sign-in flow binding the
 * DID to a Serial user; unbound rows are swept with expired auth state.
 */
export const atprotoConnections = sqliteTable(
  "atproto_connections",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("user_id")
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    did: text("did").notNull().unique(),
    session: text("session"),
    /** Scope actually granted; null when the server omitted it. */
    scopes: text("scopes"),
    handle: text("handle"),
    pdsUrl: text("pds_url"),
    status: text("status")
      .$type<"active" | "disconnected">()
      .notNull()
      .default("active"),
    /**
     * Atmosphere subscription sync settings. Both directions default off (the
     * None method) on sign-up and link; unlink resets them because the row
     * outlives the link and is reused when the DID is linked again.
     */
    importSubscriptions: integer("import_subscriptions", { mode: "boolean" })
      .notNull()
      .default(false),
    exportSubscriptions: integer("export_subscriptions", { mode: "boolean" })
      .notNull()
      .default(false),
    importAsInactive: integer("import_as_inactive", { mode: "boolean" })
      .notNull()
      .default(false),
    subscriptionBackfillStarted: integer("subscription_backfill_started", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    subscriptionBackfillNextAttemptAt: integer(
      "subscription_backfill_next_attempt_at",
      { mode: "timestamp_ms" },
    ),
    subscriptionRequestId: text("subscription_request_id"),
    subscriptionNextAttemptAt: integer("subscription_next_attempt_at", {
      mode: "timestamp_ms",
    }),
    subscriptionJobToken: text("subscription_job_token"),
    subscriptionJobExpiresAt: integer("subscription_job_expires_at", {
      mode: "timestamp_ms",
    }),
    subscriptionJobProgress: text("subscription_job_progress", {
      mode: "json",
    }).$type<{ completed: number; total: number }>(),
    subscriptionJobResult: text("subscription_job_result", {
      mode: "json",
    }).$type<PublicationSyncResult>(),
    subscriptionSyncCursor: text("subscription_sync_cursor"),
    subscriptionRepoRev: text("subscription_repo_rev"),
    subscriptionImportGeneration: integer("subscription_import_generation")
      .notNull()
      .default(0),
    subscriptionExportGeneration: integer("subscription_export_generation")
      .notNull()
      .default(0),
    subscriptionSyncToken: text("subscription_sync_token"),
    subscriptionSyncExpiresAt: integer("subscription_sync_expires_at", {
      mode: "timestamp_ms",
    }),
    // Consent only saves the submitted draft if no newer settings save won.
    syncSettingsVersion: integer("sync_settings_version").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    index("atproto_subscription_job_due_idx").on(
      table.subscriptionNextAttemptAt,
    ),
  ],
);
export const publicationBackfillProbes = sqliteTable(
  "publication_backfill_probes",
  {
    feedId: integer("feed_id")
      .primaryKey()
      .references(() => feeds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("publication_backfill_due_idx").on(
      table.userId,
      table.nextAttemptAt,
      table.feedId,
    ),
  ],
);

export type DatabaseAtprotoConnection = typeof atprotoConnections.$inferSelect;

/** Retain absent records as tombstones so neither side resurrects an unsubscribe. */
export const atprotoSubscriptionMirror = sqliteTable(
  "atproto_subscription_mirror",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => atprotoConnections.id, { onDelete: "cascade" }),
    publicationUri: text("publication_uri").notNull(),
    recordUri: text("record_uri").notNull(),
    recordCid: text("record_cid"),
    // No Feed FK: a deleted Feed must remain observable until sync processes it.
    feedId: integer("feed_id"),
    provenance: text("provenance").$type<"serial" | "imported">().notNull(),
    visibility: text("visibility")
      .$type<"public" | "private">()
      .notNull()
      .default("public"),
    remotePresent: integer("remote_present", { mode: "boolean" })
      .notNull()
      .default(true),
    importState: text("import_state").$type<"pending" | "skipped">(),
    importRetryAt: integer("import_retry_at", { mode: "timestamp" }),
    importFailures: integer("import_failures").notNull().default(0),
    importGeneration: integer("import_generation").notNull().default(0),
    exportGeneration: integer("export_generation").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .$default(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.connectionId,
        table.publicationUri,
        table.recordUri,
        table.visibility,
      ],
    }),
    index("atproto_subscription_mirror_publication_idx").on(
      table.connectionId,
      table.publicationUri,
    ),
  ],
);
export type DatabaseSubscriptionMirror =
  typeof atprotoSubscriptionMirror.$inferSelect;

// === App Config (app-wide settings) ===

/**
 * Type-safe app config key -> value mappings
 */
export type AppConfigKeys = {
  "public-signup-enabled": "true" | "false";
  "enabled-signin-providers": string; // JSON array, e.g. '["email","oauth"]'
  "enabled-signup-providers": string; // JSON array, e.g. '["email","oauth"]'
  "admin-notify-on-signup": "true" | "false";
  "admin-notify-email": string; // email address to notify
};

export type AppConfigKey = keyof AppConfigKeys;

export const appConfig = sqliteTable("app_config", {
  key: text("key").$type<AppConfigKey>().primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .$default(() => new Date())
    .notNull(),
});
export type DatabaseAppConfig = typeof appConfig.$inferSelect;
