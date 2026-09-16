ALTER TABLE `serial_atproto_subscription_mirror` ADD `import_state` text;--> statement-breakpoint
ALTER TABLE `serial_atproto_subscription_mirror` ADD `import_retry_at` integer;--> statement-breakpoint
ALTER TABLE `serial_atproto_subscription_mirror` ADD `import_failures` integer DEFAULT 0 NOT NULL;