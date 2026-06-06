-- B — DQ1 (2026-06-06): venue/promoter dedup canary parity.
--
-- Extends dedup_sweep_snapshots (drizzle/0099) to track per-surface dup
-- snapshots so a single canary can monitor all three entity types
-- (events, venues, promoters) with one table + three rows per day.
--
-- 1. surface column — 'events' | 'venues' | 'promoters'. Defaulted to
--    'events' so existing rows reflect their historical meaning. Hard
--    constraint via CHECK so a typo can't slip in.
-- 2. Re-key the snapshot_date uniqueness to (snapshot_date, surface).
--    Without this the second row of the day for the same date would
--    upsert over the first regardless of surface.
-- 3. Re-purposed semantics: for 'events' surface, eventsInClusters means
--    what it always has — events involved in some cluster. For 'venues'
--    it means venues involved in some venue cluster; for 'promoters',
--    promoters involved in some promoter cluster. The events-specific
--    sub-columns (venue_date_clusters, city_state_date_clusters) carry
--    0 for non-events surfaces — they're event-keyed match shapes that
--    don't apply.

ALTER TABLE dedup_sweep_snapshots
  ADD COLUMN surface TEXT NOT NULL DEFAULT 'events'
  CHECK (surface IN ('events', 'venues', 'promoters'));

-- Drop the date-only unique and rekey to include surface. SQLite doesn't
-- support `DROP INDEX IF EXISTS … CASCADE`; the explicit DROP + CREATE
-- pair is fine because the table is small (one row per day per surface).
DROP INDEX IF EXISTS idx_dedup_snapshot_date;
CREATE UNIQUE INDEX IF NOT EXISTS idx_dedup_snapshot_date_surface
  ON dedup_sweep_snapshots(snapshot_date, surface);
