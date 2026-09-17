CREATE TABLE `serial_feed_item_page_image` (
	`item_id` text PRIMARY KEY NOT NULL,
	`feed_id` integer NOT NULL,
	`page_url` text NOT NULL,
	`image_url` text,
	`next_check_at` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `serial_feed_item`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feed_id`) REFERENCES `serial_feed`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `feed_item_page_image_due_idx` ON `serial_feed_item_page_image` (`feed_id`,`next_check_at`,`item_id`);