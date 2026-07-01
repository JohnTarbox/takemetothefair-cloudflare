CREATE TABLE `promoter_enrichment_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`promoter_id` text NOT NULL,
	`job_run_id` text NOT NULL,
	`proposed_field` text NOT NULL,
	`current_value` text,
	`proposed_value` text NOT NULL,
	`source_url` text NOT NULL,
	`extraction_method` text NOT NULL,
	`fetch_method` text,
	`confidence` real DEFAULT 0 NOT NULL,
	`flags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`reviewed_at` integer,
	`reviewed_by` text,
	`decision` text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pec_promoter` ON `promoter_enrichment_candidates` (`promoter_id`);--> statement-breakpoint
CREATE INDEX `idx_pec_decision` ON `promoter_enrichment_candidates` (`decision`);--> statement-breakpoint
CREATE INDEX `idx_pec_job_run` ON `promoter_enrichment_candidates` (`job_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pec_pending_field` ON `promoter_enrichment_candidates` (`promoter_id`,`proposed_field`) WHERE "promoter_enrichment_candidates"."decision" = 'pending';--> statement-breakpoint
ALTER TABLE `promoters` ADD `enrichment_attempted_at` integer;