CREATE TABLE `serial_feed_origin` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`feed_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`kind` text(16) NOT NULL,
	`locator` text(1024) NOT NULL,
	`etag` text,
	`last_modified_header` text,
	`last_fetched_at` integer,
	`next_fetch_at` integer,
	`repo_rev` text,
	`publication_did` text,
	`publication_rkey` text,
	`pds_url` text(512),
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
ALTER TABLE `serial_feed` ADD `site_url` text(512);--> statement-breakpoint
ALTER TABLE `serial_feed` ADD `name_edited_at` integer;