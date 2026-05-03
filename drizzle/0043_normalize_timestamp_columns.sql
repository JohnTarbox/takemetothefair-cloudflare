-- Phase 5 (date architecture cleanup, 2026-05-02)
--
-- Migrate the remaining 7 tables that store timestamps as raw INTEGER
-- seconds-epoch onto Drizzle's mode:"timestamp" convention (ms-epoch). Same
-- pattern as 0040 (url_domain_classifications). After this migration the
-- entire codebase uses one timestamp unit.
--
-- Multiplying by 1000 brings existing 10-digit second values up to the
-- 13-digit millisecond form Drizzle expects when reading via
-- integer({ mode: "timestamp" }).
--
-- Tables migrated (and their columns):
--   - analytics_events:        timestamp
--   - indexnow_submissions:    timestamp
--   - error_logs:              timestamp
--   - health_issues:           first_detected_at, last_detected_at, resolved_at
--   - health_issue_snoozes:    snoozed_until, snoozed_at
--   - gsc_inspection_state:    last_inspected_at
--   - recommendation_items:    first_seen_at, last_seen_at, dismissed_at,
--                              dismissed_until, acted_at
--
-- Schema and consumer updates ship in the same PR.
--
-- IMPORTANT: run `npm run db:backup` before applying to production. This
-- migration is destructive (overwrites existing column values) and cannot
-- be auto-reverted. After backup + migration apply, the new code that reads
-- these columns as Date objects must be deployed within ~5 minutes; during
-- the deploy window, the still-running old code that writes raw seconds
-- into these columns will produce briefly-incorrect timestamps for new
-- rows. Acceptable for admin-facing data.

UPDATE analytics_events     SET timestamp         = timestamp         * 1000 WHERE timestamp         < 100000000000;
UPDATE indexnow_submissions SET timestamp         = timestamp         * 1000 WHERE timestamp         < 100000000000;
UPDATE error_logs           SET timestamp         = timestamp         * 1000 WHERE timestamp         < 100000000000;

UPDATE health_issues        SET first_detected_at = first_detected_at * 1000 WHERE first_detected_at < 100000000000;
UPDATE health_issues        SET last_detected_at  = last_detected_at  * 1000 WHERE last_detected_at  < 100000000000;
UPDATE health_issues        SET resolved_at       = resolved_at       * 1000 WHERE resolved_at       < 100000000000;

UPDATE health_issue_snoozes SET snoozed_until     = snoozed_until     * 1000 WHERE snoozed_until     < 100000000000;
UPDATE health_issue_snoozes SET snoozed_at        = snoozed_at        * 1000 WHERE snoozed_at        < 100000000000;

UPDATE gsc_inspection_state SET last_inspected_at = last_inspected_at * 1000 WHERE last_inspected_at < 100000000000;

UPDATE recommendation_items SET first_seen_at     = first_seen_at     * 1000 WHERE first_seen_at     < 100000000000;
UPDATE recommendation_items SET last_seen_at      = last_seen_at      * 1000 WHERE last_seen_at      < 100000000000;
UPDATE recommendation_items SET dismissed_at      = dismissed_at      * 1000 WHERE dismissed_at      < 100000000000 AND dismissed_at IS NOT NULL;
UPDATE recommendation_items SET dismissed_until   = dismissed_until   * 1000 WHERE dismissed_until   < 100000000000 AND dismissed_until IS NOT NULL;
UPDATE recommendation_items SET acted_at          = acted_at          * 1000 WHERE acted_at          < 100000000000 AND acted_at IS NOT NULL;

UPDATE recommendation_rules SET created_at        = created_at        * 1000 WHERE created_at        < 100000000000;
