-- Add total-match-count + last-scan tracking to recommendation_rules.
--
-- Why: the engine previously scanned each rule with a hard SQL LIMIT 25 and
-- stored only that slice in recommendation_items. Two consequences:
--   (a) admins didn't know whether 25 affected vendors meant "25 total" or
--       "25 of N — go fix these and the next batch surfaces"; and
--   (b) items whose entity stopped matching the rule weren't auto-resolved,
--       only decayed via a 7-day last_seen_at window, leaving stale payloads
--       on the page for a week.
--
-- This migration adds the metadata the engine needs to fix both:
--   - total_match_count: the unbounded count from the latest scan, surfaced
--     in the admin UI as "Showing N of M".
--   - last_scanned_at: when the rule was last evaluated. Useful for staleness
--     reasoning later; harmless to record now.
--
-- Both columns are additive; default 0 / NULL is safe for the next scan to
-- overwrite. No backfill needed — the engine writes fresh values on each run.

ALTER TABLE recommendation_rules ADD COLUMN total_match_count INTEGER DEFAULT 0;
ALTER TABLE recommendation_rules ADD COLUMN last_scanned_at INTEGER;
