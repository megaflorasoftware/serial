INSERT INTO serial_feed_item_page_image (item_id, feed_id, page_url, next_check_at)
SELECT item.id, item.feed_id, item.url, 0
FROM serial_feed_item AS item
INNER JOIN serial_feed AS feed ON feed.id = item.feed_id
WHERE feed.platform = 'website'
ON CONFLICT(item_id) DO NOTHING;
