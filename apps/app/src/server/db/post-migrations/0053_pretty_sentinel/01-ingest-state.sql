UPDATE serial_feed_item SET body_source = CASE WHEN content = '' THEN 'none' ELSE 'rss' END;
--> statement-breakpoint
UPDATE serial_feed_origin SET etag = NULL, last_modified_header = NULL;
--> statement-breakpoint
INSERT INTO serial_feed_item_alias (feed_id, locator, item_id)
SELECT item.feed_id, 'rss:' || item.content_id, item.id
FROM serial_feed_item AS item JOIN serial_feed AS feed ON feed.id = item.feed_id
WHERE feed.platform = 'website'
ON CONFLICT (feed_id, locator) DO NOTHING;
