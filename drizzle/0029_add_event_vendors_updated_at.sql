-- Phase 5: track when an event_vendors row last changed so we can compute
-- promoter response-time stats (avg time from APPLIED to decision).
ALTER TABLE event_vendors ADD COLUMN updated_at INTEGER;

-- Backfill existing rows: stamp as created_at so stats don't treat pre-migration
-- rows as instantly-decided (which would wrongly pull the median toward zero).
UPDATE event_vendors SET updated_at = created_at WHERE updated_at IS NULL;
