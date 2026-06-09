-- DQ4 (Dev-Email-2026-06-08 §C, 2026-06-08) — drop NOT NULL on
-- event_days.open_time and event_days.close_time.
--
-- Background: many event_days rows store '09:00'/'17:00' generic defaults
-- because the suggest-event submit, admin import-url, and inbound-email
-- ingest paths fell back to "10:00"/"18:00" or "09:00"/"17:00" when the
-- source page didn't expose hours. That fabricated value renders on the
-- public event page and (per PR #400 / PR 3 of this bundle) the print
-- sheet as if the hours were authoritative.
--
-- Per email §C2.4: "a missing value is honest; a wrong default isn't."
-- The schema change here makes the columns nullable. Ingest paths (in
-- the same PR) write NULL + set events.flagged_for_review=1 when source
-- hours aren't captured; the render layer (DailyScheduleDisplay) shows
-- "Hours not yet confirmed" instead of fabricating times.
--
-- The existing 9-5 rows are NOT mass-updated by this migration — that's
-- an operator triage task (per email §C2.2, bulk-flag-for-review queue
-- via the runbook at docs/runbooks/dq4-9-5-daily-sweep.md, not a one-
-- shot dev sweep). The migration only enables NULL going forward.
--
-- SQLite doesn't support ALTER COLUMN to drop NOT NULL. Standard
-- recreate-and-copy pattern:
--   1. Build event_days_new with the relaxed schema
--   2. Copy every existing row across (they all have non-null times
--      today; the relaxed schema accepts that input)
--   3. Drop the original; rename _new → event_days
--   4. Recreate any indices that lived on the original

PRAGMA foreign_keys=OFF;

CREATE TABLE event_days_new (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  open_time   TEXT,                    -- WAS: TEXT NOT NULL (drizzle/<original>)
  close_time  TEXT,                    -- WAS: TEXT NOT NULL (drizzle/<original>)
  notes       TEXT,
  closed      INTEGER DEFAULT 0,
  vendor_only INTEGER DEFAULT 0,
  created_at  INTEGER
);

-- Per-day per-event uniqueness existed via the original schema's
-- design but wasn't a UNIQUE constraint; nothing to recreate here.
-- The events FK + ON DELETE CASCADE is preserved through the column
-- definition above.

INSERT INTO event_days_new (id, event_id, date, open_time, close_time, notes, closed, vendor_only, created_at)
  SELECT id, event_id, date, open_time, close_time, notes, closed, vendor_only, created_at
  FROM event_days;

DROP TABLE event_days;
ALTER TABLE event_days_new RENAME TO event_days;

PRAGMA foreign_keys=ON;
