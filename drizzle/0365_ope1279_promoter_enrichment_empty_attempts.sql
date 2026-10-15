-- OPE-1279 — the promoter-enrichment queue never drains.
--
-- OPE-962 (drizzle/0283) moved a promoter to EXHAUSTED after 3 consecutive
-- fetches that staged ZERO candidates. In prod that never fired (0 EXHAUSTED
-- rows on 2026-10-15, queue depth 636): a site that re-proposes the same
-- unreviewed logo or regex phone every run stages a candidate every run, so the
-- streak reset forever, and the 21-day attempt filter only rotated the rows.
--
-- The new counter counts consecutive LIVE attempts that applied no field AND
-- staged no NEW candidate (a (field, value) the promoter never had a candidate
-- row for). At 2 the dispatcher sets enrichment_status = 'EXHAUSTED'.
--
-- Additive, no backfill: every row starts at 0, so exhaustion is earned by two
-- live attempts after deploy and this migration changes no row's status.
-- No-op on an empty database: an ADD COLUMN with a constant default.

ALTER TABLE promoters ADD COLUMN enrichment_empty_attempts INTEGER NOT NULL DEFAULT 0;
