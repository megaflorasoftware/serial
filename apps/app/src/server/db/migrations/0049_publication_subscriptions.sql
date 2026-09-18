CREATE TABLE `serial_feed_origin` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text(16) NOT NULL,
	`locator` text(1024) NOT NULL,
	`last_fetched_at` integer,
	`next_fetch_at` integer,
	`source_name` text(256),
	`source_image_url` text(512),
	`source_description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `serial_feed`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `serial_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_origin_user_id_kind_locator_idx` ON `serial_feed_origin` (`user_id`,`kind`,`locator`);--> statement-breakpoint
CREATE INDEX `feed_origin_user_id_next_fetch_at_idx` ON `serial_feed_origin` (`user_id`,`next_fetch_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `feed_origin_feed_id_kind_unique` ON `serial_feed_origin` (`feed_id`,`kind`);--> statement-breakpoint
CREATE TABLE `serial_feed_origin_rss` (
  `origin_id` integer PRIMARY KEY NOT NULL,
  `etag` text,
  `last_modified_header` text,
  `alternate_locators` text,
  FOREIGN KEY (`origin_id`) REFERENCES `serial_feed_origin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `serial_feed_origin_atproto` (
  `origin_id` integer PRIMARY KEY NOT NULL,
  `publication_did` text NOT NULL,
  `listing_etag` text,
  `repo_rev` text,
  `cursor` text,
  `boundary` text,
  `newest_rkey` text,
  `pending_rev` text,
  `retry_cursor` text,
  `initial_count` integer DEFAULT 0 NOT NULL,
  `initialized` integer DEFAULT false NOT NULL,
  FOREIGN KEY (`origin_id`) REFERENCES `serial_feed_origin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_origin_atproto_publication_did_idx` ON `serial_feed_origin_atproto` (`publication_did`);
--> statement-breakpoint
CREATE TABLE `serial_feed_origin_atproto_document` (
  `origin_id` integer NOT NULL,
  `uri` text NOT NULL,
  `cid` text NOT NULL,
  `status` text NOT NULL,
  PRIMARY KEY (`origin_id`, `uri`),
  FOREIGN KEY (`origin_id`) REFERENCES `serial_feed_origin_atproto`(`origin_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_origin_atproto_document_retry_idx` ON `serial_feed_origin_atproto_document` (`origin_id`,`status`,`uri`);
--> statement-breakpoint
ALTER TABLE `serial_feed` ADD `site_url` text(512);--> statement-breakpoint
ALTER TABLE `serial_feed` ADD `name_edited_at` integer;
--> statement-breakpoint
-- Legacy cache headers are intentionally cleared so origins fetch fresh data.
INSERT INTO serial_feed_origin (
  feed_id,
  user_id,
  kind,
  locator,
  last_fetched_at,
  next_fetch_at,
  source_name,
  source_image_url,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  'rss',
  url,
  last_fetched_at,
  next_fetch_at,
  name,
  image_url,
  created_at,
  updated_at
FROM serial_feed;
--> statement-breakpoint
INSERT INTO serial_feed_origin_rss (origin_id) SELECT id FROM serial_feed_origin WHERE kind = 'rss';
--> statement-breakpoint
DROP INDEX `feed_user_id_url_idx`;--> statement-breakpoint
DROP INDEX `feed_user_id_is_active_next_fetch_at_idx`;--> statement-breakpoint
DROP INDEX `feed_user_id_is_active_idx`;--> statement-breakpoint
CREATE INDEX `feed_user_id_is_active_idx` ON `serial_feed` (`user_id`,`is_active`);--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `url`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `last_fetched_at`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `next_fetch_at`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `etag`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `last_modified_header`;
--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `import_subscriptions` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `export_subscriptions` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `import_as_inactive` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `sync_settings_version` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE `serial_feed_item_alias` (
	`feed_id` integer NOT NULL,
	`locator` text NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`feed_id`, `locator`),
	FOREIGN KEY (`feed_id`) REFERENCES `serial_feed`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `serial_feed_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_item_alias_item_idx` ON `serial_feed_item_alias` (`item_id`);--> statement-breakpoint
CREATE TABLE `serial_feed_item_observation` (
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`item_id`, `kind`),
	FOREIGN KEY (`item_id`) REFERENCES `serial_feed_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `serial_feed_item` ADD `source_kind` text DEFAULT 'rss' NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_feed_item` ADD `atproto_uri` text;--> statement-breakpoint
ALTER TABLE `serial_feed_item` ADD `body_source` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_feed_item` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `feed_item_feed_normalized_url_idx` ON `serial_feed_item` (`feed_id`,`normalized_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `feed_item_feed_atproto_uri_unique` ON `serial_feed_item` (`feed_id`,`atproto_uri`);
--> statement-breakpoint
UPDATE serial_feed_item SET body_source = 'rss' WHERE content <> '';
--> statement-breakpoint
CREATE TABLE `serial_atproto_subscription_mirror` (
	`connection_id` text NOT NULL,
	`publication_uri` text NOT NULL,
	`record_uri` text NOT NULL,
	`record_cid` text,
	`feed_id` integer,
	`provenance` text NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`remote_present` integer DEFAULT true NOT NULL,
	`import_generation` integer DEFAULT 0 NOT NULL,
	`export_generation` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`import_state` text,
	`import_retry_at` integer,
	`import_failures` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`connection_id`, `publication_uri`, `record_uri`, `visibility`),
	FOREIGN KEY (`connection_id`) REFERENCES `serial_atproto_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `atproto_subscription_mirror_publication_idx` ON `serial_atproto_subscription_mirror` (`connection_id`,`publication_uri`);--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_sync_cursor` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_repo_rev` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_import_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_export_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_sync_token` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_sync_expires_at` integer;
--> statement-breakpoint
-- Earlier Feed edits did not record name provenance. Preserve existing names
-- conservatively; Feeds created after this migration still derive their names.
UPDATE serial_feed
SET name_edited_at = unixepoch()
WHERE name_edited_at IS NULL AND name <> '';
--> statement-breakpoint
CREATE TABLE `serial_publication_backfill_probes` (
	`feed_id` integer PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	FOREIGN KEY (`feed_id`) REFERENCES `serial_feed`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `serial_user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `publication_backfill_due_idx` ON `serial_publication_backfill_probes` (`user_id`,`next_attempt_at`,`feed_id`);--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_backfill_started` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_backfill_next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_request_id` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_job_token` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_job_expires_at` integer;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_job_progress` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `subscription_job_result` text;--> statement-breakpoint
CREATE INDEX `atproto_subscription_job_due_idx` ON `serial_atproto_connections` (`subscription_next_attempt_at`);
--> statement-breakpoint
ALTER TABLE `serial_user` ADD `onboarding_complete` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_user` ADD `onboarding_step` text;
--> statement-breakpoint
UPDATE serial_user SET onboarding_complete = 1;
