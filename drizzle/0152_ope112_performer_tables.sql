-- OPE-112 (performer tracking — Phase 0, 2026-07-06) — hand-authored per the
-- OPE-21 migration workflow (numbering owned by the orchestrator; deploy applies
-- via `wrangler d1 migrations apply` by filename — no meta snapshot needed).
-- Latest migration is 0151; this is 0152.
--
-- Net-new first-class entity for acts that appear at events (e.g. "Mr. Drew and
-- His Animals Too"). Three tables mirroring the vendors machinery:
--   performers            → the entity (mirrors `vendors`)
--   event_performers      → one row per APPEARANCE/set (mirrors `event_vendors`)
--   performer_slug_history→ slug-change 301s (mirrors `vendor_slug_history`)
--
-- Purely additive; no writes to existing tables. Tables are unused until Phase 1
-- (OPE-113). `act_category` is free TEXT on purpose (value-set is a Phase-1 TS
-- enum, same as vendor_type). The event_performers UNIQUE key INCLUDES
-- performance_start so a performer can appear multiple times at one event; SQLite
-- treats NULLs as distinct, so a NULL performance_start needs app-layer dedupe.
-- Rollback: DROP TABLE performer_slug_history; DROP TABLE event_performers; DROP TABLE performers;
CREATE TABLE `performers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`performer_type` text,
	`act_category` text,
	`description` text,
	`website` text,
	`social_links` text,
	`image_url` text,
	`image_focal_x` real DEFAULT 0.5 NOT NULL,
	`image_focal_y` real DEFAULT 0.5 NOT NULL,
	`home_base_city` text,
	`home_base_state` text,
	`contact_name` text,
	`contact_email` text,
	`contact_phone` text,
	`verified` integer DEFAULT false NOT NULL,
	`verified_pro` integer DEFAULT false NOT NULL,
	`claimed` integer DEFAULT false NOT NULL,
	`claimed_at` integer,
	`claimed_by` text,
	`enhanced_profile` integer DEFAULT false NOT NULL,
	`enhanced_profile_started_at` integer,
	`enhanced_profile_expires_at` integer,
	`enrichment_source` text,
	`enrichment_attempted_at` integer,
	`domain_hijacked` integer DEFAULT false NOT NULL,
	`completeness_score` integer DEFAULT 0 NOT NULL,
	`redirect_to_performer_id` text,
	`alias_of_performer_id` text,
	`view_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`claimed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`redirect_to_performer_id`) REFERENCES `performers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`alias_of_performer_id`) REFERENCES `performers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `performers_user_id_unique` ON `performers` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `performers_slug_unique` ON `performers` (`slug`);--> statement-breakpoint
CREATE TABLE `event_performers` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`performer_id` text NOT NULL,
	`event_day_id` text,
	`performance_start` integer,
	`performance_end` integer,
	`stage` text,
	`billing` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`source_url` text,
	`notes` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`performer_id`) REFERENCES `performers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_day_id`) REFERENCES `event_days`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_event_performers_unique` ON `event_performers` (`event_id`,`performer_id`,`event_day_id`,`performance_start`);--> statement-breakpoint
CREATE INDEX `idx_event_performers_event` ON `event_performers` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_event_performers_performer` ON `event_performers` (`performer_id`);--> statement-breakpoint
CREATE INDEX `idx_event_performers_event_day` ON `event_performers` (`event_day_id`);--> statement-breakpoint
CREATE TABLE `performer_slug_history` (
	`id` text PRIMARY KEY NOT NULL,
	`performer_id` text NOT NULL,
	`old_slug` text NOT NULL,
	`new_slug` text NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text,
	FOREIGN KEY (`performer_id`) REFERENCES `performers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_performer_slug_history_old_slug` ON `performer_slug_history` (`old_slug`);--> statement-breakpoint
CREATE INDEX `idx_performer_slug_history_performer_id` ON `performer_slug_history` (`performer_id`);
