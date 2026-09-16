-- Earlier Feed edits did not record name provenance. Preserve existing names
-- conservatively; Feeds created after this migration still derive their names.
UPDATE serial_feed
SET name_edited_at = unixepoch()
WHERE name_edited_at IS NULL AND name <> '';
