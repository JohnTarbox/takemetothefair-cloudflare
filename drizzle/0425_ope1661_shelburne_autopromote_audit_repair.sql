-- OPE-1661 — restore the ONE audit row the 2026-11-17 06:00Z tentative-autopromote
-- run (OPE-1586) failed to write.
--
-- That run promoted winter-lights-at-shelburne-museum-2026 TENTATIVE → SCHEDULED
-- (the guarded UPDATE landed at 1794895208), then its `event.lifecycle_change`
-- INSERT failed with "D1 DB is overloaded" — the two were separate awaits, now
-- one batch (same PR). Without this row the event is invisible to the rule's
-- reversal pass (which finds its own promotions BY this row) and to
-- get_event_lifecycle_history.
--
-- The row is reproduced verbatim from the failed statement's params in Workers
-- Logs (meetmeatthefair-mcp, 2026-11-17T06:00:18.040Z), including its original
-- id, so the repair is the row the code meant to write, not a new claim.
--
-- docs/bulk-mutation-discipline.md:
--   single-writer — one statement, one row.
--   idempotent    — ON CONFLICT(id) DO NOTHING on the original id, and the
--                   NOT EXISTS clause skips it if any rule audit row is present.
--   guarded       — writes only while the event still holds EXACTLY the rule's
--                   promotion (SCHEDULED, same changed_at, same reason). If a
--                   person has transitioned it since, their row is the history
--                   and this one would be false, so it is skipped.
--   empty db      — SELECT FROM events WHERE id = … yields no row: a no-op.
--   read-back     — SELECT id FROM admin_actions WHERE id = 'd1c53052-70f3-40d5-8048-9bf4ba161352';
--   rollback      — DELETE FROM admin_actions WHERE id = 'd1c53052-70f3-40d5-8048-9bf4ba161352';
INSERT INTO admin_actions (id, action, actor_user_id, target_type, target_id, payload_json, created_at)
SELECT
  'd1c53052-70f3-40d5-8048-9bf4ba161352',
  'event.lifecycle_change',
  NULL,
  'event',
  e.id,
  '{"previous_lifecycle":"TENTATIVE","new_lifecycle":"SCHEDULED","reason":"auto (OPE-1586): organizer page agrees — \"Nov. 27!\" at https://shelburnemuseum.org/visit/winter-lights/","slug":"winter-lights-at-shelburne-museum-2026","via":"tentative-autopromote","rule":"OPE-1586","matched_url":"https://shelburnemuseum.org/visit/winter-lights/","matched_text":"Nov. 27!"}',
  1794895208
FROM events e
WHERE e.id = 'b1cd9658-50de-425c-afc0-74f52dfa8180'
  AND e.lifecycle_status = 'SCHEDULED'
  AND e.lifecycle_status_changed_at = 1794895208
  AND e.lifecycle_reason LIKE 'auto (OPE-1586): organizer page agrees%'
  AND NOT EXISTS (
    SELECT 1 FROM admin_actions a
     WHERE a.target_type = 'event' AND a.target_id = e.id
       AND a.action = 'event.lifecycle_change'
       AND a.created_at >= 1794895208
  )
ON CONFLICT(id) DO NOTHING;
