-- OPE-13 (vendor-roster rails, 2026-06-28) — per-event roster-research state.
--
-- The keystone of the vendor-roster backfill system. Today the only signal that
-- an event has a researched vendor roster is the list_event_vendors count, which
-- cannot distinguish "no public list exists" from "never researched" — so every
-- sweep re-researches the same dead-ends (Maine Cannabis Expo, Top O' Maine,
-- Portland Golf). A persistent status field makes dead-ends STICKY and the
-- process CONVERGE.
--
--   vendor_roster_status (nullable enum):
--     NULL            → never evaluated (every existing row at deploy)
--     'NEEDS_RESEARCH'→ past event, no roster yet, not yet attempted
--                       (set by the just-occurred sweep)
--     'HAS_ROSTER'    → roster attached (set by the research worker)
--     'NO_PUBLIC_LIST'→ researched dead-end; organizer publishes no findable list
--     'PARTIAL'       → some linked; source incomplete or hit a cap;
--                       vendor_roster_offset = resume point for the next run
--
-- Columns are nullable with no default, so existing rows are unaffected (they
-- read as NULL = never evaluated). Enum is enforced at the Drizzle layer
-- (packages/db-schema events.vendorRosterStatus); SQLite stores plain TEXT.
--
-- Read path: get_event_details. Write path: set_vendor_roster_status (ADMIN MCP
-- tool) so the analyst sweep can record results. Coverage metric + the queue
-- scan both read the partial index below.
--
-- Verify not already present:  PRAGMA table_info('events');
ALTER TABLE events ADD COLUMN vendor_roster_status TEXT;
ALTER TABLE events ADD COLUMN vendor_roster_checked_at INTEGER;
ALTER TABLE events ADD COLUMN vendor_roster_source_url TEXT;
ALTER TABLE events ADD COLUMN vendor_roster_offset INTEGER;

-- Partial index for the research-queue drain (NEEDS_RESEARCH) + the coverage
-- metric. Most rows are NULL (never evaluated), so the partial keeps it small.
CREATE INDEX IF NOT EXISTS idx_events_vendor_roster_status
  ON events(vendor_roster_status)
  WHERE vendor_roster_status IS NOT NULL;
