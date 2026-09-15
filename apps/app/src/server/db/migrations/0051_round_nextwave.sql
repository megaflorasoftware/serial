ALTER TABLE `serial_atproto_connections` ADD `import_subscriptions` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `export_subscriptions` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `serial_atproto_connections` ADD `import_as_inactive` integer DEFAULT false NOT NULL;