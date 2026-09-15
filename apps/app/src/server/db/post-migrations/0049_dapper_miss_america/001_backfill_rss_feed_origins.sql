INSERT INTO serial_feed_origin (
  feed_id,
  user_id,
  kind,
  locator,
  etag,
  last_modified_header,
  last_fetched_at,
  next_fetch_at,
  source_name,
  source_image_url,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  'rss',
  url,
  etag,
  last_modified_header,
  last_fetched_at,
  next_fetch_at,
  name,
  image_url,
  created_at,
  updated_at
FROM serial_feed
WHERE NOT EXISTS (
    SELECT 1
    FROM serial_feed_origin
    WHERE serial_feed_origin.feed_id = serial_feed.id
      AND serial_feed_origin.kind = 'rss'
  );
