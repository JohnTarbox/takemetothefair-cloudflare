-- OPE-1088 — one row per (event, date, vendor_only).
--
-- event_days accepted unlimited rows for the same (event_id, date), and the
-- ingest/enrichment writer INSERTed, so a later better-sourced correction sat
-- BESIDE the stale value and both rendered: the Hartford CT Fall Home Show
-- (4,306 views) carried 10:00-18:00 and 11:00-17:00 for the same day for six
-- months. The upsert in insert-helpers.ts is the fix; this index is the guard.
--
-- vendor_only is IN the key on purpose: a public day and a vendor-setup window
-- on the same date are two real, distinct facts (GAHS 2026-05-16, Garden &
-- Craft Fair 2026-05-30). A key of (event_id, date) alone would reject them.
--
-- This will FAIL LOUDLY if any collision remains, which is the intent — the
-- three that blocked it were resolved first (organizer-checked where a source
-- still existed; see the ticket). Verified 0 collisions immediately before.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_days_event_date_vendor
  ON event_days(event_id, date, vendor_only);
