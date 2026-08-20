-- OPE-425 review gate — the columns findings 1, 2 and 3 need.
--
-- Additive only. Every column is nullable or defaulted, nothing reads them
-- until the loader runs, and the loader is still a deliberate separate step.
--
-- 1. county_note / county_vintage — county geography is NOT immutable. The
--    Census replaced Connecticut's eight legacy counties with NINE PLANNING
--    REGIONS as county-equivalents (approved 2022, implemented 2024), and the
--    2023 Gazetteer already carries them. The only published place-to-county
--    relationship file is the 2020 vintage, which still uses the LEGACY
--    counties — so CT's 185 CDPs are left unassigned with the reason recorded
--    in county_vintage rather than mixed. Same discipline population_year
--    already applies.
--
-- 2. venues.location_matched_by — the first backfill matched on name only, so
--    "unmatched" conflated a genuinely junk city string (an OPE-421 defect)
--    with a string that merely failed to join. `MA | Cape Cod` was offered as
--    the proof case and carries coordinates in Barnstable County.
--
-- 3. is_denominator_eligible — a CDP's population is a SUBSET of its parent
--    municipality's, so SUM(population) over every row double-counts and
--    inflates every coverage denominator by 791 non-municipal rows. Per-capita
--    grading is this table's first named application. A column rather than a
--    per-query convention, because a convention has to be remembered by every
--    future caller and a column does not.
ALTER TABLE locations ADD COLUMN county_note TEXT;
ALTER TABLE locations ADD COLUMN county_vintage TEXT;
ALTER TABLE locations ADD COLUMN is_denominator_eligible INTEGER NOT NULL DEFAULT 1;
ALTER TABLE venues ADD COLUMN location_matched_by TEXT;

-- The denominator rule, applied to anything already loaded. A no-op on an
-- empty table, which is the state CI builds and the state prod is in today
-- (the loader has deliberately never been run).
UPDATE locations SET is_denominator_eligible = 0 WHERE type = 'village_cdp';

CREATE INDEX IF NOT EXISTS idx_locations_denominator
  ON locations (state, is_denominator_eligible);
