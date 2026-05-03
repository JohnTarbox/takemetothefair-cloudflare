-- Backfill: NULL out events.description rows that were polluted by import-time
-- fallback strings. Three offending writers were fixed in this PR:
--
--   1. src/lib/scrapers/vtnhfairs.ts — wrote `Contact: {text}` into description.
--      3 prod events affected (vtnhfairs.org-vt source).
--   2. src/app/api/admin/import/route.ts — fallback `{name} - imported from
--      {sourceName}` when scraper had no description. 43 prod events affected
--      (mainefairs.net + mafa.org).
--   3. src/app/api/admin/import-url/route.ts — fallback `{name} - imported
--      from URL`. Count unknown but covered by the same predicate.
--
-- Total: 46 prod rows as of 2026-05-03.
--
-- Once description is null, the round-2 meta-description fallback chain
-- (venue/category-derived text) takes over for SEO. Restoring real
-- descriptions is a separate manual job.
--
-- Idempotency: this UPDATE matches by description LIKE pattern; once a row's
-- description is NULL the LIKE predicates can't match it, so re-running is a
-- no-op. Safe per feedback_idempotent_migration_guards.

UPDATE events
SET description = NULL
WHERE description LIKE 'Contact:%'
   OR description LIKE '%- imported from%';
