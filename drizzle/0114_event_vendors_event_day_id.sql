-- F — K18 Phase 1 (2026-06-06): per-occurrence vendor links.
--
-- Adds `event_day_id` (nullable FK → event_days) to `event_vendors` so
-- recurring-event series can scope a vendor's participation to a specific
-- occurrence rather than the whole series.
--
-- Semantics:
--   - event_day_id IS NULL  → series-wide / regular participant (today's
--     behavior; every existing row migrates to this state).
--   - event_day_id IS NOT NULL → vendor participates on that specific
--     occurrence only.
--
-- Uniqueness via two partial indexes (SQLite NULL-distinct gotcha):
--   - SQLite treats NULLs as distinct in a UNIQUE index, so a bare
--     UNIQUE(event_id, vendor_id, event_day_id) would NOT prevent two
--     series-wide rows for the same (event, vendor).
--   - The two partials enforce:
--       (a) at most one series-wide row per (event, vendor)
--       (b) at most one per-day row per (event, vendor, event_day_id)
--   - A vendor linked both series-wide AND on a specific date is
--     intentionally allowed — useful for "regular participant, plus has
--     a featured slot on Jul 3" semantics.
--
-- ON DELETE CASCADE on event_day_id: deleting an event_day removes the
-- occurrence, so its date-scoped vendor links go with it. Series-wide
-- (NULL) links untouched.
--
-- Migration safety: ADD COLUMN with default NULL is non-destructive; all
-- 2,325 existing event_vendors rows become series-wide automatically.
-- No data backfill required.

ALTER TABLE event_vendors ADD COLUMN event_day_id TEXT
  REFERENCES event_days(id) ON DELETE CASCADE;

-- New indexes for the per-day query shapes.
CREATE INDEX IF NOT EXISTS idx_eventvendors_event_day_id
  ON event_vendors(event_id, event_day_id);
CREATE INDEX IF NOT EXISTS idx_eventvendors_vendor_day_id
  ON event_vendors(vendor_id, event_day_id);

-- Replace the old (event_id, vendor_id) unique with two partials.
DROP INDEX IF EXISTS idx_eventvendors_event_vendor_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_eventvendors_series_unique
  ON event_vendors(event_id, vendor_id)
  WHERE event_day_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_eventvendors_perday_unique
  ON event_vendors(event_id, vendor_id, event_day_id)
  WHERE event_day_id IS NOT NULL;
