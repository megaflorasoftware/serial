DROP INDEX `feed_user_id_url_idx`;--> statement-breakpoint
DROP INDEX `feed_user_id_is_active_next_fetch_at_idx`;--> statement-breakpoint
DROP INDEX `feed_user_id_is_active_idx`;--> statement-breakpoint
CREATE INDEX `feed_user_id_is_active_idx` ON `serial_feed` (`user_id`,`is_active`);--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `url`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `last_fetched_at`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `next_fetch_at`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `etag`;--> statement-breakpoint
ALTER TABLE `serial_feed` DROP COLUMN `last_modified_header`;