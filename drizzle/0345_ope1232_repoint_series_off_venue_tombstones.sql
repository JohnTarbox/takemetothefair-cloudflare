-- OPE-1232 — repoint event_series.venue_id off venue-merge tombstones.
--
-- merge_venue moved only events.venue_id, so every series hub whose venue was
-- merged away still points at the INACTIVE `*-merged-*` tombstone. Measured
-- 2026-10-01: 10 rows (rollback + before-state: docs/ope1232/rollback.sql).
--
-- The keeper is resolved from the record, not hard-coded: merge_venue writes a
-- venue_slug_history row tombstone-slug -> keeper (OPE-1183). Only a keeper
-- that is itself ACTIVE is taken, so a chained merge is left for a person.
-- A former venue that is INACTIVE but was never merged (e.g. Montpelier
-- Fairgrounds, OPE-1180) has no `-merged-` slug and is untouched.
--
-- Idempotent, and a no-op on an empty database (CI builds D1 from migrations).
UPDATE event_series
SET venue_id = (
      SELECT h.venue_id
      FROM venue_slug_history h
      JOIN venues k ON k.id = h.venue_id AND k.status = 'ACTIVE'
      WHERE h.old_slug = (SELECT v.slug FROM venues v WHERE v.id = event_series.venue_id)
        AND h.venue_id <> event_series.venue_id
      ORDER BY h.changed_at DESC
      LIMIT 1
    ),
    updated_at = unixepoch()
WHERE venue_id IN (SELECT id FROM venues WHERE status = 'INACTIVE' AND slug LIKE '%-merged-%')
  AND EXISTS (
      SELECT 1
      FROM venue_slug_history h
      JOIN venues k ON k.id = h.venue_id AND k.status = 'ACTIVE'
      WHERE h.old_slug = (SELECT v.slug FROM venues v WHERE v.id = event_series.venue_id)
        AND h.venue_id <> event_series.venue_id
    );
