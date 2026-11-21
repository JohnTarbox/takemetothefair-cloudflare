-- OPE-1683 — two contact obligations were answered by an approved operator
-- draft, then closed by hand as `not_needed` only because the send path did
-- not recognise a hand-composed draft as a reply (fixed in the same PR). Re-mark
-- them `answered`, at the draft's send time, naming the draft.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer: this migration only.
--   idempotent:    keyed on id AND status='not_needed'; a re-run, or an
--                  empty database (CI), changes 0 rows.
--   read-back:     SELECT id, status, closed_at, closed_by FROM support_obligations
--                  WHERE id IN ('ae03f162-238a-4b13-9c2b-212fc5f2c710',
--                               '62696e98-39c0-4537-8410-171815a58ab9');
--                  expect both `answered`, closed_at 1794791278 / 1795003738.
--   rollback:      prior values, read from prod 2026-11-18 —
--                  ae03f162…: status not_needed, closed_at 1794791295, closed_by admin-user-001
--                  62696e98…: status not_needed, closed_at 1795003749, closed_by admin-user-001
--                  (close_note is kept below, prefixed, so the original text survives).
UPDATE support_obligations
SET status = 'answered',
    closed_at = 1794791278,
    closed_by = 'backfill:OPE-1683',
    close_note = 'Answered by approved operator draft 06df6362-7a32-4985-8026-2d6f83439a92 (sent 2026-11-16T01:07Z); re-marked from not_needed by OPE-1683. Original note: ' || coalesce(close_note, '')
WHERE id = 'ae03f162-238a-4b13-9c2b-212fc5f2c710' AND status = 'not_needed';

UPDATE support_obligations
SET status = 'answered',
    closed_at = 1795003738,
    closed_by = 'backfill:OPE-1683',
    close_note = 'Answered by approved operator draft 9fdc56e6-79f8-4995-b17f-3df7a1944ddf (sent 2026-11-18T12:08Z); re-marked from not_needed by OPE-1683. Original note: ' || coalesce(close_note, '')
WHERE id = '62696e98-39c0-4537-8410-171815a58ab9' AND status = 'not_needed';
