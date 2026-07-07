-- OPE-116 (2026-07-06) — performer-enrichment rails + candidates table.
--
-- The performer analog of the promoter enrichment pipeline (drizzle/0140 +
-- 0141). Adds the per-performer enrichment lifecycle columns + backfills them,
-- and creates the pre-extraction staging table drained by the review tools.
-- Hand-authored (drizzle never emits data migrations); DDL matches the Drizzle
-- schema in packages/db-schema/src/index.ts.
--
-- Fields differ from promoters: a performer has ONE image_url (no hero/logo
-- split), so coverage is {image, description, socials, contact}.
ALTER TABLE `performers` ADD `enrichment_status` text;--> statement-breakpoint
ALTER TABLE `performers` ADD `enrichment_coverage` text;--> statement-breakpoint
ALTER TABLE `performers` ADD `last_enriched_at` integer;--> statement-breakpoint
ALTER TABLE `performers` ADD `enrichment_blocked_reason` text;--> statement-breakpoint

CREATE TABLE `performer_enrichment_candidates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`performer_id` text NOT NULL,
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
CREATE INDEX `idx_perf_ec_performer` ON `performer_enrichment_candidates` (`performer_id`);--> statement-breakpoint
CREATE INDEX `idx_perf_ec_decision` ON `performer_enrichment_candidates` (`decision`);--> statement-breakpoint
CREATE INDEX `idx_perf_ec_job_run` ON `performer_enrichment_candidates` (`job_run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_perf_ec_pending_field` ON `performer_enrichment_candidates` (`performer_id`,`proposed_field`) WHERE "performer_enrichment_candidates"."decision" = 'pending';--> statement-breakpoint

-- Backfill (a): per-field coverage snapshot {image,description,socials,contact}
-- as JSON booleans, matching computePerformerEnrichment's output shape exactly.
-- (Performer descriptions have no boilerplate placeholder — blank is the only
-- "missing" case, unlike promoters.)
UPDATE performers SET enrichment_coverage = json_object(
  'image', json(CASE WHEN image_url IS NOT NULL AND trim(image_url) != '' THEN 'true' ELSE 'false' END),
  'description', json(CASE WHEN description IS NOT NULL AND trim(description) != '' THEN 'true' ELSE 'false' END),
  'socials', json(CASE WHEN social_links IS NOT NULL AND trim(social_links) NOT IN ('', '[]', '{}')
      AND lower(trim(social_links)) != 'null' THEN 'true' ELSE 'false' END),
  'contact', json(CASE WHEN (contact_email IS NOT NULL AND trim(contact_email) != '')
      OR (contact_phone IS NOT NULL AND trim(contact_phone) != '') THEN 'true' ELSE 'false' END)
);--> statement-breakpoint

-- Backfill (b): derive status from the coverage just written + website presence.
-- all covered -> ENRICHED; no website -> NO_SOURCE; else NEEDS_ENRICHMENT.
UPDATE performers SET enrichment_status = CASE
  WHEN json_extract(enrichment_coverage, '$.image') = 1
   AND json_extract(enrichment_coverage, '$.description') = 1
   AND json_extract(enrichment_coverage, '$.socials') = 1
   AND json_extract(enrichment_coverage, '$.contact') = 1
    THEN 'ENRICHED'
  WHEN website IS NULL OR trim(website) = '' THEN 'NO_SOURCE'
  ELSE 'NEEDS_ENRICHMENT'
END;
