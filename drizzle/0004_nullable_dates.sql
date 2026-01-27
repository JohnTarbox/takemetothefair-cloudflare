PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`promoter_id` text NOT NULL,
	`venue_id` text NOT NULL,
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
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "name", "slug", "description", "promoter_id", "venue_id", "start_date", "end_date", "recurrence_rule", "categories", "tags", "ticket_url", "ticket_price_min", "ticket_price_max", "image_url", "featured", "commercial_vendors_allowed", "status", "view_count", "source_name", "source_url", "source_id", "sync_enabled", "last_synced_at", "created_at", "updated_at") SELECT "id", "name", "slug", "description", "promoter_id", "venue_id", "start_date", "end_date", "recurrence_rule", "categories", "tags", "ticket_url", "ticket_price_min", "ticket_price_max", "image_url", "featured", "commercial_vendors_allowed", "status", "view_count", "source_name", "source_url", "source_id", "sync_enabled", "last_synced_at", "created_at", "updated_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);