-- OPE-1257 — a rolled-forward edition must say what it was rolled from.
--
-- All 120 `annual_rollover` rows in production share ONE created_at second
-- (2026-06-15 14:37:59Z) and have no admin_actions row: they were written by a
-- single bulk INSERT … SELECT run directly against D1, not by any code path in
-- this repo, and it set no `rolled_from_event_id`. 103 were repaired by
-- drizzle/0302 (OPE-1116), 2 by hand (OPE-820), 19 have no findable parent.
-- The statement is not on disk anywhere (OneDrive workspace, skills, every repo
-- under /home and every surviving session transcript were searched), so there
-- is no script to retire — only one that could be typed again.
--
-- The in-repo writer (mcp-server/src/event-rollover.ts, `auto_rollover`)
-- already sets the link and is tested. This trigger makes the rule hold on
-- EVERY write path, including an ad-hoc one: a rollover-method insert with no
-- parent is refused. INSERT only — an UPDATE trigger would also fire on the
-- FK's ON DELETE SET NULL when a parent is purged and abort that delete.
-- Existing rows are untouched; the 19 unlinkable ones stay NULL by ruling.
--
-- The method list mirrors ROLLOVER_INGESTION_METHODS (src/lib/events/derived-date.ts).
CREATE TRIGGER trg_events_rollover_requires_parent
BEFORE INSERT ON events
WHEN NEW.ingestion_method IN ('annual_rollover', 'auto_rollover', 'manual_rollover')
  AND NEW.rolled_from_event_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ROLLOVER_WITHOUT_PARENT: a rolled-forward event must set rolled_from_event_id (OPE-1257)');
END;
