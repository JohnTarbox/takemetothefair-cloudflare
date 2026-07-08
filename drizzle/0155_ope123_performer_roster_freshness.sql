-- OPE-123 (2026-07-07) — performer-lineup freshness/verification layer.
--
-- Mirrors the vendor-roster rails (drizzle/0133) for performer appearances so a
-- date-driven re-verification sweep can prioritize the stalest / soonest-
-- occurring events, and so lineup coverage is measurable.
--
--   events.performer_roster_status (nullable enum, Drizzle-enforced; TEXT here):
--     NULL                 → never evaluated (every existing row at deploy)
--     'NEEDS_RESEARCH'     → lineup not yet re-verified
--     'VERIFIED'           → lineup re-grounded against a source
--     'NO_LINEUP_PUBLISHED'→ researched dead-end; no findable lineup (sticky,
--                            makes the sweep converge)
--   Terminal statuses (everything but NEEDS_RESEARCH) stamp
--   performer_roster_checked_at.
--
--   event_performers.last_verified_at / last_verified_source — per-appearance
--   verification stamp, written by set_event_performer_status / _slot.
--
-- All columns nullable, no default → existing rows unaffected (read as NULL).
-- Verify not already present:  PRAGMA table_info('events');
ALTER TABLE events ADD COLUMN performer_roster_status TEXT;--> statement-breakpoint
ALTER TABLE events ADD COLUMN performer_roster_checked_at INTEGER;--> statement-breakpoint
ALTER TABLE events ADD COLUMN performer_roster_source_url TEXT;--> statement-breakpoint
ALTER TABLE event_performers ADD COLUMN last_verified_at INTEGER;--> statement-breakpoint
ALTER TABLE event_performers ADD COLUMN last_verified_source TEXT;--> statement-breakpoint

-- Partial index for the research-queue scan + coverage metric (mirrors
-- idx_events_vendor_roster_status). Most rows are NULL, so the partial is small.
CREATE INDEX IF NOT EXISTS idx_events_performer_roster_status
  ON events(performer_roster_status)
  WHERE performer_roster_status IS NOT NULL;--> statement-breakpoint

-- Composite for the "next N days with a stale/unverified lineup" sweep:
-- range-scan start_date, then filter/order by performer_roster_checked_at.
CREATE INDEX IF NOT EXISTS idx_events_perf_roster_checked_start
  ON events(start_date, performer_roster_checked_at);--> statement-breakpoint

-- Stalest-first ordering for the appearance re-verification drain.
CREATE INDEX IF NOT EXISTS idx_event_performers_last_verified
  ON event_performers(last_verified_at);
