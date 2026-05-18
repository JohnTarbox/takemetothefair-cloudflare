-- 2026-05-18: Shift every event with midnight-UTC start_date / end_date
-- to noon UTC (+ 12 hours). Midnight UTC = 8pm EDT yesterday / 4pm PDT
-- yesterday, so events stored at 00:00:00Z render as the PREVIOUS
-- calendar day in every US timezone — confusing user-visible bug.
-- Noon UTC = 8am EDT / 5am PST, same calendar day site-wide.
--
-- Idempotent: the WHERE clause matches only rows where (timestamp %
-- 86400 = 0), i.e., exactly aligned to a day boundary. Running the
-- migration a second time matches zero rows because the first run
-- shifted them off the boundary. Same shape as PR-B's partial-unique
-- index migration in 0073 — safe to re-run by accident.
--
-- Backfill scope (counted 2026-05-18 prior to migration):
--   751 events had at least one of start_date / end_date at midnight UTC.
-- A follow-on PR will normalize at INSERT time in the suggest-event
-- submit handler (drizzle/0074 + src/app/api/suggest-event/submit/route.ts
-- in the same PR) so this backfill is one-shot, not recurring.

UPDATE events
SET start_date = start_date + 43200
WHERE start_date IS NOT NULL
  AND start_date % 86400 = 0;

UPDATE events
SET end_date = end_date + 43200
WHERE end_date IS NOT NULL
  AND end_date % 86400 = 0;
