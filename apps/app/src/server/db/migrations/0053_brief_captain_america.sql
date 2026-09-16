CREATE TABLE `serial_feed_document_record` (
	`origin_id` integer NOT NULL,
	`uri` text NOT NULL,
	`cid` text NOT NULL,
	`status` text NOT NULL,
	PRIMARY KEY(`origin_id`, `uri`),
	FOREIGN KEY (`origin_id`) REFERENCES `serial_feed_origin`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_document_retry_idx` ON `serial_feed_document_record` (`origin_id`,`status`);--> statement-breakpoint
CREATE TABLE `serial_feed_ingest_state` (
	`origin_id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`boundary` text,
	`newest_rkey` text,
	`pending_rev` text,
	`initial_count` integer DEFAULT 0 NOT NULL,
	`initialized` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`origin_id`) REFERENCES `serial_feed_origin`(`id`) ON UPDATE no action ON DELETE cascade
);
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