-- OPE-1395 — query-cost indexes (IDX1/IDX2/IDX3) and exact-duplicate index drops (IDX6).
--
-- Schema-only: every statement is IF [NOT] EXISTS, so it is a no-op on the empty
-- D1 that CI builds from migrations and safe to re-run.
--
-- ADD
--   idx_vendors_deleted_business_name — /vendors reads `deleted_at IS NULL ORDER BY
--     business_name` (src/lib/vendors/listing-page.ts). Prod plan before: SEARCH
--     idx_vendors_deleted_at + USE TEMP B-TREE FOR ORDER BY. This serves both.
--   idx_events_source_url — find-duplicate.ts stage 1 (`source_url = ?`) ran on
--     every dedup check with no index on the column.
--   idx_events_status_effective_end — upcomingEndPredicate()/pastEndPredicate()
--     (packages/db-schema/src/event-end-predicates.ts) compare
--     COALESCE(end_date, start_date); the existing (status, end_date) index can
--     seek on status only. SQLite matches an expression index on the parsed
--     expression, so Drizzle's quoted `COALESCE("events"."end_date",
--     "events"."start_date")` matches this unquoted definition (verified with
--     EXPLAIN QUERY PLAN on the exact emitted SQL — see the PR).
--
-- DROP (each verified against prod sqlite_master on 2026-10-16 as an exact
-- duplicate of an index that stays; the survivor is the one
-- packages/db-schema declares)
--   idx_events_venue_id          (0005) == idx_events_venueid          (0022)
--   idx_events_promoter_id       (0005) == idx_events_promoterid       (0022)
--   idx_event_vendors_vendor_id  (0005) == idx_eventvendors_vendorid   (0022)
--   idx_blogposts_slug           (0023) == sqlite_autoindex_blog_posts_2 (UNIQUE slug)
--   idx_series_slug_history_old_slug (0209) == idx_series_slug_history_old_slug_unique (0209)

CREATE INDEX IF NOT EXISTS idx_vendors_deleted_business_name ON vendors(deleted_at, business_name);
CREATE INDEX IF NOT EXISTS idx_events_source_url ON events(source_url);
CREATE INDEX IF NOT EXISTS idx_events_status_effective_end ON events(status, COALESCE(end_date, start_date));

DROP INDEX IF EXISTS idx_events_venue_id;
DROP INDEX IF EXISTS idx_events_promoter_id;
DROP INDEX IF EXISTS idx_event_vendors_vendor_id;
DROP INDEX IF EXISTS idx_blogposts_slug;
DROP INDEX IF EXISTS idx_series_slug_history_old_slug;
