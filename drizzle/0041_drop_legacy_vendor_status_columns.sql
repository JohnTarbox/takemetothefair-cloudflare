-- Phase C.1 (tech-debt cleanup, 2026-05-01)
--
-- Drop the three legacy boolean columns from event_vendors that were
-- retired by migration 0019 (refactor_event_vendor_status). At the time,
-- D1 didn't support ALTER TABLE DROP COLUMN, so 0019 nulled out the
-- columns and left them dangling. SQLite 3.35+ (D1 is on a current build)
-- supports DROP COLUMN now, so we can finally remove them.
--
-- The three columns have been NULL on every row since 0019. The Drizzle
-- schema (packages/db-schema/src/index.ts) already omits them; no code
-- references remain. Dropping them just reclaims the schema space and
-- removes a "wait, what's this?" speed bump for anyone reading the table.
--
-- Pre-flight check (verified 2026-05-01):
--   PRAGMA table_info(event_vendors) confirmed all three columns present;
--   spot-check showed every value NULL.

ALTER TABLE event_vendors DROP COLUMN interested;
ALTER TABLE event_vendors DROP COLUMN applied;
ALTER TABLE event_vendors DROP COLUMN accepted;
