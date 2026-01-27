-- Make user_id nullable on promoters table
-- SQLite requires table recreation to remove NOT NULL constraint

-- Create temporary table with nullable user_id
CREATE TABLE `promoters_new` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`company_name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`website` text,
	`social_links` text,
	`logo_url` text,
	`verified` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Copy data from old table
INSERT INTO `promoters_new` SELECT * FROM `promoters`;
--> statement-breakpoint
-- Drop old table
DROP TABLE `promoters`;
--> statement-breakpoint
-- Rename new table
ALTER TABLE `promoters_new` RENAME TO `promoters`;
--> statement-breakpoint
-- Recreate unique indexes
CREATE UNIQUE INDEX `promoters_user_id_unique` ON `promoters` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `promoters_slug_unique` ON `promoters` (`slug`);
