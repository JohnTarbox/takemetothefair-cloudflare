-- Change venue_id foreign key to SET NULL on delete
-- SQLite requires table recreation to change FK constraints

-- Create temporary table with SET NULL on delete for venue_id
CREATE TABLE `events_new` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`promoter_id` text NOT NULL,
	`venue_id` text,
	`start_date` integer,
	`end_date` integer,
	`dates_confirmed` integer DEFAULT true,
	`recurrence_rule` text,
	`categories` text DEFAULT '[]',
	`tags` text DEFAULT '[]',
	`ticket_url` text,
	`ticket_price_min` real,
	`ticket_price_max` real,
	`image_url` text,
	`featured` integer DEFAULT false,
	`commercial_vendors_allowed` integer DEFAULT true,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`view_count` integer DEFAULT 0,
	`source_name` text,
	`source_url` text,
	`source_id` text,
	`sync_enabled` integer DEFAULT true,
	`last_synced_at` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`promoter_id`) REFERENCES `promoters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Copy data from old table
INSERT INTO `events_new` SELECT * FROM `events`;
--> statement-breakpoint
-- Drop old table
DROP TABLE `events`;
--> statement-breakpoint
-- Rename new table
ALTER TABLE `events_new` RENAME TO `events`;
--> statement-breakpoint
-- Recreate unique index on slug
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);
--> statement-breakpoint
-- Recreate performance indexes
CREATE INDEX IF NOT EXISTS `idx_events_venue_id` ON `events` (`venue_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_promoter_id` ON `events` (`promoter_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_status` ON `events` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_start_date` ON `events` (`start_date`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_end_date` ON `events` (`end_date`);
