-- OPE-307 (GATE-NOISE G3) — retire STALE `start_date_timezone_confused` rows.
--
-- Scope note, because it is narrower than the ticket asks. Measured on prod
-- 2026-08-03, the 359 open rows break down as:
--
--     226  event now anchored 12:00:00 UTC  -> STALE. `dateLooksTimezoneConfused`
--                                              short-circuits on noon and returns
--                                              false, so today's scan would never
--                                              file these. They were filed before
--                                              the noon-UTC backfill moved their
--                                              events, and nothing retires a row
--                                              when its condition stops holding.
--      62  event anchored 04:00/05:00 UTC   -> REAL. That is midnight EDT/EST —
--                                              a date parsed in Eastern and
--                                              converted. Genuine signal; LEFT OPEN
--                                              deliberately. Mass-resolving these
--                                              would delete the finding.
--      71  other quarter-hour times         -> plausible real event times; the
--                                              detector defers to the description.
--                                              Left open for operator judgement.
--       0  event anchored 00:00:00 UTC      -> the symptom this ticket targets does
--                                              not occur in the open queue at all.
--
-- The ingest half of the ticket needs no change: suggest_event already routes
-- through normalizeEventDate (mcp-server/src/tools/vendor.ts), and of events
-- created in the last 60 days 260 are noon-anchored against 3 at midnight.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer      one statement, run by the deploy's d1-migrate job.
--   idempotent         re-running matches nothing: the rows it touches are no
--                      longer `open`.
--   read-back-verified counts reported before/after on the ticket.
--   rollback-planned   non-destructive — nothing deleted, and every row is
--                      identifiable by resolution_status, so
--                      `UPDATE ... SET resolution_status='open', resolved_at=NULL
--                      WHERE resolution_status='superseded_by_normalization'`
--                      restores the prior state exactly.
--
-- The join to events is what makes this safe: a row is only closed when its
-- OWN event is demonstrably noon-anchored today, never on the reason alone.

UPDATE event_discrepancies
SET resolution_status = 'superseded_by_normalization',
    resolved_at = unixepoch(),
    notes = COALESCE(notes || ' | ', '') || 'OPE-307: event is noon-UTC anchored; normalization already resolved this and the detector no longer fires'
WHERE resolution_status = 'open'
  AND divergent_value = 'start_date_timezone_confused'
  AND event_id IN (
    SELECT id FROM events
    WHERE start_date IS NOT NULL
      AND strftime('%H:%M:%S', start_date, 'unixepoch') = '12:00:00'
  );
