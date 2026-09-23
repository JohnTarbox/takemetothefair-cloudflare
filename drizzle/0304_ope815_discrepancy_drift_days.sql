-- OPE-815 (09-23 bounce) — drift magnitude as a queryable COLUMN.
--
-- Acceptance line: "drift magnitude and confidence are separate columns".
-- Drift existed only as prose in `notes` ("drift 366d between stored start_date
-- and source's canonical date [...]"), and 18 of 579 radar rows have had their
-- notes rewritten by operators, so parsing notes cannot recover them.
--
-- The backfill derives the magnitude from the two DATES every radar row already
-- stores (authoritative_value = our start_date, divergent_value = the source's),
-- which covers every row with both values and needs no prose parsing.
--
-- Discipline (docs/bulk-mutation-discipline.md):
--   single-writer  — this migration; the capture path writes the column from now on
--   idempotent     — only rows with drift_days IS NULL are touched
--   read-back      — SELECT COUNT(*) ... WHERE detected_by='stale_page_radar' AND drift_days IS NULL
--   rollback       — the column is additive; rows are otherwise untouched
--   empty db       — an UPDATE with no matching rows is a no-op
ALTER TABLE event_discrepancies ADD COLUMN drift_days INTEGER;

UPDATE event_discrepancies
SET drift_days = CAST(ROUND(ABS(julianday(divergent_value) - julianday(authoritative_value))) AS INTEGER)
WHERE detected_by = 'stale_page_radar'
  AND drift_days IS NULL
  AND julianday(divergent_value) IS NOT NULL
  AND julianday(authoritative_value) IS NOT NULL;
