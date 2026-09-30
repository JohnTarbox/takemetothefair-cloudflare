-- OPE-1116 — backfill `events.rolled_from_event_id` for the rollover cohort
-- that never recorded its parent.
--
-- WHY THE COLUMN WAS EMPTY (read from source, not inferred):
--   The 124 rolled rows (121 `annual_rollover`, 3 `manual_rollover`, created
--   2026-06-13..15) came from an OFFLINE one-shot script that did not set the
--   column — see src/lib/events/derived-date.ts. The committed writer,
--   mcp-server/src/event-rollover.ts, DOES set it (tested, event-rollover.test.ts)
--   but has never run in prod: only 3 events carry FREQ=YEARLY and none has
--   reached OCCURRED (measured 2026-09-23).
--
-- WHAT THIS WRITES:
--   Only rows whose parent is UNAMBIGUOUS — exactly one non-rollover, non-merged
--   event in the same series whose start year is the child's minus one.
--   Measured on prod 2026-09-23 over the 124:
--     103  exactly one candidate   → linked here
--       2  two or more candidates  → left NULL (a guess is worse than a gap)
--      19  no candidate            → left NULL
--
-- Discipline (docs/bulk-mutation-discipline.md):
--   single-writer   — one migration statement.
--   idempotent      — `rolled_from_event_id IS NULL` guard; a re-run writes 0.
--   no-op on empty  — every row is found by self-join; an empty db matches none.
--   read-back       — after deploy:
--       SELECT COUNT(*) FROM events
--       WHERE ingestion_method IN ('annual_rollover','manual_rollover')
--         AND rolled_from_event_id IS NOT NULL;          -- expect 103
--   rollback        — nothing else has ever written this column on these rows:
--       UPDATE events SET rolled_from_event_id = NULL
--       WHERE ingestion_method IN ('annual_rollover','manual_rollover');
--
-- `updated_at` is deliberately NOT bumped: this is lineage metadata, not a
-- content change, and updated_at feeds sitemap lastmod and queue-outflow counts.
UPDATE events
SET rolled_from_event_id = (
  SELECT p.id FROM events p
  WHERE p.series_id = events.series_id
    AND p.id != events.id
    AND p.merged_into IS NULL
    AND p.ingestion_method NOT IN ('annual_rollover', 'manual_rollover')
    AND CAST(strftime('%Y', p.start_date, 'unixepoch') AS INTEGER)
        = CAST(strftime('%Y', events.start_date, 'unixepoch') AS INTEGER) - 1
)
WHERE ingestion_method IN ('annual_rollover', 'manual_rollover')
  AND merged_into IS NULL
  AND rolled_from_event_id IS NULL
  AND series_id IS NOT NULL
  AND start_date IS NOT NULL
  AND (
    SELECT COUNT(*) FROM events p
    WHERE p.series_id = events.series_id
      AND p.id != events.id
      AND p.merged_into IS NULL
      AND p.ingestion_method NOT IN ('annual_rollover', 'manual_rollover')
      AND CAST(strftime('%Y', p.start_date, 'unixepoch') AS INTEGER)
          = CAST(strftime('%Y', events.start_date, 'unixepoch') AS INTEGER) - 1
  ) = 1;
