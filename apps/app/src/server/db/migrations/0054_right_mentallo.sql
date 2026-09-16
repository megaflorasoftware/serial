DROP INDEX `feed_document_retry_idx`;--> statement-breakpoint
CREATE INDEX `feed_document_retry_idx` ON `serial_feed_document_record` (`origin_id`,`status`,`uri`);--> statement-breakpoint
ALTER TABLE `serial_feed_ingest_state` ADD `retry_cursor` text;