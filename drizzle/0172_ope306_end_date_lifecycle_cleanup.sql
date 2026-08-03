-- OPE-306 (GATE-NOISE G2) — retire the `end_date_in_past` discrepancy backlog.
--
-- `end_date_in_past` is true of every event that has simply finished. There is
-- nothing for an operator to correct: the daily OCCURRED sweep already moves
-- APPROVED past-end events to OCCURRED, and `status` staying APPROVED
-- afterwards is the correct end state (APPROVED is the moderation verdict,
-- OCCURRED is the lifecycle position — different columns, both right).
--
-- Measured on prod 2026-08-03: 2,377 open `end_date_in_past` rows, a third of
-- the whole 7,193-row queue, none actionable. The retro counted 270 distinct
-- conditions; the gap is the OPE-305 duplicate explosion (~9 copies each), so
-- 0171 collapses them and this statement closes what remains.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer      one statement, run by the deploy's d1-migrate job.
--   idempotent         only matches rows still `open`; after one run there are
--                      none, so a replay is a no-op.
--   read-back-verified counts reported before/after on the ticket.
--   rollback-planned   non-destructive — no row deleted, each is identifiable by
--                      resolution_status='superseded_by_lifecycle', so
--                      `UPDATE ... SET resolution_status='open', resolved_at=NULL
--                      WHERE resolution_status='superseded_by_lifecycle'`
--                      restores the prior state exactly.
--
-- Scoped by divergent_value, which is where captureSelfConsistencyDiscrepancy
-- stores the evaluateGates reason verbatim.

UPDATE event_discrepancies
SET resolution_status = 'superseded_by_lifecycle',
    resolved_at = unixepoch(),
    notes = COALESCE(notes || ' | ', '') || 'OPE-306: end_date_in_past is a lifecycle state, owned by the OCCURRED sweep — not an operator-actionable discrepancy'
WHERE resolution_status = 'open'
  AND divergent_value = 'end_date_in_past';
