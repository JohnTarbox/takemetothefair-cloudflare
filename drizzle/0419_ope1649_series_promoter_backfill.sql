-- OPE-1649 — series left on the "Community Suggestions" placeholder after
-- their events got a real promoter.
--
-- `event_series.promoter_id` is the series landing's JSON-LD organizer (for the
-- series and every subEvent) and the promoter a new occurrence inherits.
-- `update_event(promoter_id)` never carried a reassignment to the series (fixed
-- in the same PR), so a series minted while its event sat on the placeholder
-- kept serving "Community Suggestions" after the event was reassigned.
--
-- Scope, measured on prod 2026-11-16: 145 series with live members disagree
-- with at least one member. This migration touches ONLY the unambiguous subset,
-- 96 series where:
--   * the series is on the placeholder, AND
--   * every live member (merged_into IS NULL) has the SAME non-null promoter,
--     which is not the placeholder and exists in `promoters`.
-- The other 49 (14 placeholder series whose members disagree with each other,
-- 35 series on a real promoter) are a review list on the ticket, not a rewrite.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer  — one migration, applied once by the deploy job.
--   idempotent     — both statements key on `promoter_id = placeholder`; after
--                    the UPDATE no row matches, so a re-run is a no-op. On an
--                    empty database neither statement matches anything.
--   read-back      — the audit rows are written FIRST, from the same predicate,
--                    so count(audit rows) must equal the rows the UPDATE changed;
--                    the PR posts both, read from prod after the deploy.
--   rollback       — one statement, from the audit rows (`payload_json.from`):
--     UPDATE event_series SET promoter_id = 'system-community-suggestions',
--            updated_at = unixepoch()
--      WHERE id IN (SELECT target_id FROM admin_actions
--                    WHERE action = 'series.promoter_backfill_ope1649')
--        AND promoter_id = (SELECT json_extract(payload_json, '$.to')
--                             FROM admin_actions a
--                            WHERE a.action = 'series.promoter_backfill_ope1649'
--                              AND a.target_id = event_series.id);

-- (a) Audit row per series about to change: before → after, so the rollback
--     above is exact and the read-back has a count to compare.
INSERT INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at)
SELECT
  lower(hex(randomblob(16))),
  'series.promoter_backfill_ope1649',
  NULL,
  'event_series',
  s.id,
  json_object(
    'from', s.promoter_id,
    'to', (SELECT MIN(e.promoter_id) FROM events e WHERE e.series_id = s.id AND e.merged_into IS NULL),
    'reason', 'OPE-1649: series on the placeholder; every live member has this one real promoter'
  ),
  unixepoch()
FROM event_series s
WHERE s.promoter_id = 'system-community-suggestions'
  AND (SELECT MIN(e.promoter_id) FROM events e WHERE e.series_id = s.id AND e.merged_into IS NULL)
      <> 'system-community-suggestions'
  AND NOT EXISTS (
    SELECT 1 FROM events e
     WHERE e.series_id = s.id AND e.merged_into IS NULL
       AND (e.promoter_id IS NULL
            OR e.promoter_id <> (SELECT MIN(e2.promoter_id) FROM events e2
                                  WHERE e2.series_id = s.id AND e2.merged_into IS NULL))
  )
  AND EXISTS (
    SELECT 1 FROM promoters p
     WHERE p.id = (SELECT MIN(e.promoter_id) FROM events e WHERE e.series_id = s.id AND e.merged_into IS NULL)
  );

-- (b) The rewrite, on exactly the same predicate.
UPDATE event_series
SET promoter_id = (SELECT MIN(e.promoter_id) FROM events e
                    WHERE e.series_id = event_series.id AND e.merged_into IS NULL),
    updated_at = unixepoch()
WHERE promoter_id = 'system-community-suggestions'
  AND (SELECT MIN(e.promoter_id) FROM events e
        WHERE e.series_id = event_series.id AND e.merged_into IS NULL)
      <> 'system-community-suggestions'
  AND NOT EXISTS (
    SELECT 1 FROM events e
     WHERE e.series_id = event_series.id AND e.merged_into IS NULL
       AND (e.promoter_id IS NULL
            OR e.promoter_id <> (SELECT MIN(e2.promoter_id) FROM events e2
                                  WHERE e2.series_id = event_series.id AND e2.merged_into IS NULL))
  )
  AND EXISTS (
    SELECT 1 FROM promoters p
     WHERE p.id = (SELECT MIN(e.promoter_id) FROM events e
                    WHERE e.series_id = event_series.id AND e.merged_into IS NULL)
  );
