-- Add vendor_only flag to event_days (for setup days hidden from public)
ALTER TABLE event_days ADD COLUMN vendor_only INTEGER DEFAULT 0;

-- Add public date range to events (excludes vendor-only days)
ALTER TABLE events ADD COLUMN public_start_date INTEGER;
ALTER TABLE events ADD COLUMN public_end_date INTEGER;

-- Backfill: all existing days are public, so public dates = full dates
UPDATE events SET public_start_date = start_date, public_end_date = end_date
WHERE start_date IS NOT NULL;
