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