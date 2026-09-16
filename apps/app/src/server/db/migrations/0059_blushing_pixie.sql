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