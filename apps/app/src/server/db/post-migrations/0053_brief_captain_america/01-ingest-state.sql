UPDATE serial_feed_item SET body_source = CASE WHEN content = '' THEN 'none' ELSE 'rss' END;
--> statement-breakpoint
UPDATE serial_feed_origin SET etag = NULL, last_modified_header = NULL;
