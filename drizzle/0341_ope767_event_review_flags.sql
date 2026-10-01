-- OPE-767 — WHY an event is flagged for review (John, 2026-09-30: option A).
-- events.flagged_for_review stays, maintained as the OR of the ACTIVE rows here.
-- Cleared rows are kept: they are the audit trail of who discharged what.
CREATE TABLE IF NOT EXISTS event_review_flags (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  raised_at INTEGER NOT NULL,
  raised_by TEXT,
  cleared_at INTEGER,
  cleared_by TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_review_flags_event
  ON event_review_flags (event_id, cleared_at);
-- One ACTIVE row per (event, reason); cleared history may repeat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_review_flags_active
  ON event_review_flags (event_id, reason) WHERE cleared_at IS NULL;

-- Backfill: every row flagged today gets reason 'legacy' — its real reason was
-- never recorded, so no automatic axis may discharge it; a reviewer clears it.
-- Idempotent (NOT EXISTS), and a no-op on an empty database (CI builds one).
INSERT INTO event_review_flags (id, event_id, reason, raised_at, raised_by, note)
SELECT lower(hex(randomblob(16))), e.id, 'legacy', unixepoch('now'), 'drizzle/0341',
       'flagged before reasons were recorded'
FROM events e
WHERE e.flagged_for_review = 1
  AND NOT EXISTS (SELECT 1 FROM event_review_flags f WHERE f.event_id = e.id AND f.cleared_at IS NULL);
