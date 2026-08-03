-- OPE-305 (GATE-NOISE G1) — dedup-on-open + one-time queue cleanup.
--
-- captureDiscrepancy deduped only within a 24h window, so the daily cron
-- re-filed every persistent condition forever. Measured on prod 2026-08-03:
-- 7,193 open rows across 619 distinct (event_id, field_class, detected_by)
-- groups = 6,574 duplicates (91.4%); the worst single condition had 40 copies.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer      — one migration statement, not a fan-out.
--   idempotent         — the cleanup UPDATE only touches rows that are NOT the
--                        oldest open row of their group. After the first run each
--                        group has exactly one open row, so a re-run matches
--                        nothing. Safe to replay.
--   read-back-verified — counts reported before/after on the ticket.
--   rollback-planned   — non-destructive: no row is deleted. Every superseded row
--                        keeps its data and is identifiable by
--                        resolution_status='superseded_duplicate' + notes, so
--                        `UPDATE ... SET resolution_status='open', resolved_at=NULL
--                        WHERE resolution_status='superseded_duplicate'` restores
--                        the prior state exactly.

-- 1. Track re-observation without inserting a second row.
ALTER TABLE event_discrepancies ADD COLUMN last_seen_at INTEGER;

-- 2. Backfill: an existing row was last seen when it was detected.
UPDATE event_discrepancies SET last_seen_at = detected_at WHERE last_seen_at IS NULL;

-- 3. The new dedup lookup is keyed on the open tuple — index it so the
--    per-capture check stays a point lookup rather than a scan of 7k rows.
CREATE INDEX IF NOT EXISTS idx_event_discrepancies_open_tuple
  ON event_discrepancies (event_id, field_class, detected_by, resolution_status);

-- 4. Carry the newest sighting onto the row we are about to keep, so the
--    surviving row records how recently the condition was actually observed.
--    Runs BEFORE the supersede step, while the duplicates are still open.
UPDATE event_discrepancies AS keep
SET last_seen_at = (
  SELECT MAX(d.detected_at) FROM event_discrepancies d
  WHERE d.event_id = keep.event_id
    AND d.field_class = keep.field_class
    AND d.detected_by = keep.detected_by
    AND d.resolution_status = 'open'
)
WHERE keep.resolution_status = 'open';

-- 5. Supersede every open row that is not the oldest of its group.
--    Oldest = MIN(detected_at), tie-broken by id so the choice is deterministic
--    and a replay picks the same survivor.
UPDATE event_discrepancies
SET resolution_status = 'superseded_duplicate',
    resolved_at = unixepoch(),
    notes = COALESCE(notes || ' | ', '') || 'OPE-305: superseded by the older open row for the same (event, field_class, detected_by)'
WHERE resolution_status = 'open'
  AND id NOT IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY event_id, field_class, detected_by
               ORDER BY detected_at ASC, id ASC
             ) AS rn
      FROM event_discrepancies
      WHERE resolution_status = 'open'
    ) ranked
    WHERE rn = 1
  );
