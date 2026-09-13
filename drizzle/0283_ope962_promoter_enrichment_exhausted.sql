-- OPE-962 — promoter enrichment gets a terminal state for "nothing left to extract".
--
-- NEEDS_ENRICHMENT had no exit short of every field filling, so a promoter whose
-- site yields no further signal was re-fetched on every ~30-day cycle forever and
-- the queue could only grow (485 on 2026-08-19, 516 on 2026-09-13). The dispatcher
-- now counts consecutive successful fetches that stage zero candidates and moves
-- the promoter to enrichment_status = 'EXHAUSTED' at 3.
--
-- The status is a plain text column (drizzle/0140 declared no CHECK), so the new
-- value needs no table rebuild — only the counter column.
--
-- Every existing row starts at 0: exhaustion is earned going forward, not
-- back-filled from history, so this migration changes no row's status.
--
-- No-op on an empty database: an ADD COLUMN with a constant default.

ALTER TABLE promoters ADD COLUMN enrichment_zero_yield_streak INTEGER NOT NULL DEFAULT 0;
