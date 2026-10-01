-- OPE-1256 (OPE-767 option D) — the organizer publishes NO hours for this day.
--
-- OPE-1069 added `close_time_unpublished` for "no closing time is published".
-- This is the whole-day version: harmony-free-fair's 4 days have NULL hours
-- because the organizer publishes none (verified twice under OPE-767), and the
-- missing-hours review reason could never clear, because "not yet known" and
-- "never published" were the same NULL. A day with this set is a settled
-- finding, not a research gap. Default 0: every existing row is unchanged.
ALTER TABLE event_days ADD COLUMN hours_unpublished INTEGER NOT NULL DEFAULT 0
  CHECK (hours_unpublished IN (0, 1));
